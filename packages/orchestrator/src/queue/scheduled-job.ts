/**
 * Orchestrator scheduled-job wrapper.
 *
 * Mirrors `packages/platform/src/queue/scheduled-job.ts` in observable
 * surface (5 Prometheus metrics + structured logs + audit row on
 * failure) but uses `setInterval` instead of pg-boss — the orchestrator
 * has no pg-boss dependency and we're not adding one.
 *
 * All future orchestrator periodic jobs MUST use this wrapper — per
 * CLAUDE.md "no workarounds", the legacy setInterval call sites in
 * queue/cleanup.ts and secrets/cleanup.ts migrate in the same phase
 * they'd otherwise be updated.
 *
 * `triggerNow()` on the returned handle forces one off-cadence tick
 * (used by the admin `/api/v1/admin/scheduled-jobs/:name/trigger`
 * endpoint and by E2E harnesses). It does NOT reset the interval
 * timer — a real tick still fires at the scheduled cadence after.
 */
import { z } from 'zod';
import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import {
  jobConsecutiveFailures,
  jobDurationSeconds,
  jobLastFailureTimestamp,
  jobLastSuccessTimestamp,
  jobRunsTotal,
} from '../metrics/scheduled-jobs.js';

const logger = createLogger({ prefix: 'scheduled-job' });

/**
 * All registered orchestrator scheduled-job names. Adding a new
 * periodic job MUST add its name here before it can register.
 */
export const OrchestratorScheduledJobName = z.enum([
  'cleanup',
  'orphan-secret-cleanup',
  'token-cleanup',
  'cold-store-archive',
  'cold-store-purge',
]);
export type OrchestratorScheduledJobName = z.infer<typeof OrchestratorScheduledJobName>;

/** Access-log action for a scheduled job tick failure. */
const ACCESS_LOG_ACTION_TICK_FAILURE = 'scheduled_job.tick';
/** Access-log action for a manually triggered off-cadence tick. */
export const ACCESS_LOG_ACTION_TRIGGER = 'scheduled_job.trigger';

export interface OrchestratorScheduledJobOptions {
  name: OrchestratorScheduledJobName;
  /** Tick cadence. Must be > 0. */
  intervalMs: number;
  /** Handler called per tick. Exceptions are caught and metered. */
  handler: () => Promise<void>;
  /**
   * Orchestrator instance ID — appears on failure access-log rows as
   * `actor_id` alongside `actor_type='system'`.
   */
  instanceId: string;
  /** DB used for failure audit rows. If omitted, failures are logs-only. */
  db?: Kysely<Database>;
  /** Routing key for failure access-log partitioning (null = not scoped). */
  routingKey?: string;
  /** Fire one tick immediately on register. Defaults to false. */
  runOnStart?: boolean;
  /** `timer.unref()` — allows process exit while scheduled. Defaults to true. */
  unref?: boolean;
}

export interface OrchestratorScheduledJobHandle {
  readonly name: OrchestratorScheduledJobName;
  /** Clears the interval. Safe to call multiple times. */
  stop(): void;
  /**
   * Force one off-cadence tick and await it (success or failure).
   * Returns the tick's outcome so E2E and admin routes can report it.
   */
  triggerNow(): Promise<{ ok: boolean; durationMs: number; error?: string }>;
}

/** Per-job in-memory metric state, like Platform's. */
interface JobMetricEntry {
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}

const jobMetricState = new Map<string, JobMetricEntry>();
const handleRegistry = new Map<OrchestratorScheduledJobName, OrchestratorScheduledJobHandle>();

/**
 * Readonly snapshot of per-job metric state. Used by the admin
 * `/api/v1/admin/scheduled-jobs` route to surface last-run info.
 */
export function getOrchestratorJobMetricState(): ReadonlyMap<
  string,
  { consecutiveFailures: number; lastSuccessAt: Date | null; lastFailureAt: Date | null }
> {
  return jobMetricState;
}

/**
 * Look up a registered scheduled job's handle by name. Returns
 * `undefined` if the job isn't registered on this instance. Used by
 * the admin trigger-now endpoint.
 */
export function findOrchestratorScheduledJob(
  name: OrchestratorScheduledJobName,
): OrchestratorScheduledJobHandle | undefined {
  return handleRegistry.get(name);
}

/**
 * Clear the scheduled-job registry. Intended for tests only —
 * production code should keep a stable set of registered jobs.
 */
export function __resetOrchestratorScheduledJobsForTesting(): void {
  for (const handle of handleRegistry.values()) {
    handle.stop();
  }
  handleRegistry.clear();
  jobMetricState.clear();
}

export function registerOrchestratorScheduledJob(
  opts: OrchestratorScheduledJobOptions,
): OrchestratorScheduledJobHandle {
  if (opts.intervalMs <= 0) {
    throw new Error(`registerOrchestratorScheduledJob: intervalMs must be > 0`);
  }
  if (handleRegistry.has(opts.name)) {
    throw new Error(`registerOrchestratorScheduledJob: duplicate registration for ${opts.name}`);
  }

  if (!jobMetricState.has(opts.name)) {
    jobMetricState.set(opts.name, {
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
  }

  let inFlight: Promise<{ ok: boolean; durationMs: number; error?: string }> | null = null;
  let stopped = false;

  async function runOnce(): Promise<{ ok: boolean; durationMs: number; error?: string }> {
    // Single-flight per handle — if one is in progress, reuse it.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const startedAt = Date.now();
      try {
        logger.info('Scheduled job starting', { job: opts.name });
        await opts.handler();
        const durationMs = Date.now() - startedAt;
        const durationSeconds = durationMs / 1000;

        jobDurationSeconds.record(durationSeconds, { job: opts.name });
        jobRunsTotal.add(1, { job: opts.name, result: 'success' });
        jobLastSuccessTimestamp.set({ job: opts.name }, Math.floor(Date.now() / 1000));
        jobConsecutiveFailures.set({ job: opts.name }, 0);

        const entry = jobMetricState.get(opts.name)!;
        entry.consecutiveFailures = 0;
        entry.lastSuccessAt = new Date();

        logger.info('Scheduled job completed', { job: opts.name, durationMs });
        return { ok: true, durationMs };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const durationSeconds = durationMs / 1000;
        const errMsg = toErrorMessage(err);

        jobDurationSeconds.record(durationSeconds, { job: opts.name });
        jobRunsTotal.add(1, { job: opts.name, result: 'failure' });
        jobLastFailureTimestamp.set({ job: opts.name }, Math.floor(Date.now() / 1000));

        const entry = jobMetricState.get(opts.name)!;
        entry.consecutiveFailures += 1;
        entry.lastFailureAt = new Date();
        jobConsecutiveFailures.set({ job: opts.name }, entry.consecutiveFailures);

        logger.error('Scheduled job failed', { job: opts.name, durationMs, error: errMsg });

        if (opts.db) {
          writeFailureAccessLog(opts, errMsg).catch((auditErr) =>
            logger.error('Failed to write access_log for scheduled-job failure', {
              job: opts.name,
              error: toErrorMessage(auditErr),
            }),
          );
        }

        return { ok: false, durationMs, error: errMsg };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    if (stopped) return;
    void runOnce();
  }, opts.intervalMs);
  if (opts.unref !== false) {
    timer.unref();
  }

  if (opts.runOnStart === true) {
    // Kick synchronously so startup is responsive.
    void runOnce();
  }

  const handle: OrchestratorScheduledJobHandle = {
    name: opts.name,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      handleRegistry.delete(opts.name);
    },
    async triggerNow() {
      return runOnce();
    },
  };
  handleRegistry.set(opts.name, handle);
  logger.info('Scheduled job registered', {
    job: opts.name,
    intervalMs: opts.intervalMs,
    runOnStart: opts.runOnStart === true,
  });
  return handle;
}

async function writeFailureAccessLog(
  opts: OrchestratorScheduledJobOptions,
  errorMessage: string,
): Promise<void> {
  if (!opts.db) return;
  await opts.db
    .insertInto('access_log')
    .values({
      org_id: null,
      routing_key: opts.routingKey ?? null,
      actor_type: 'system',
      actor_id: opts.instanceId,
      actor_meta: null,
      action: ACCESS_LOG_ACTION_TICK_FAILURE,
      target_type: 'scheduled_job',
      target_id: opts.name,
      request_id: null,
      source: 'system',
      outcome: 'failure',
      error_message: errorMessage,
    })
    .execute();
}
