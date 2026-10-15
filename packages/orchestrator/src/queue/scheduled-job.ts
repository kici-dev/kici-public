/**
 * Orchestrator scheduled-job wrapper. Mirrors the Platform's wrapper in
 * observable surface (the Prometheus metrics, structured logs, an audit row on
 * failure) but uses `setInterval`: the orchestrator deliberately takes no
 * pg-boss dependency.
 *
 * Every orchestrator periodic job MUST use this wrapper, as the cleanup jobs
 * in queue/cleanup.ts and secrets/cleanup.ts do.
 *
 * `triggerNow()` forces one off-cadence tick (for the admin
 * `/api/v1/admin/scheduled-jobs/:name/trigger` endpoint and tests). It does
 * NOT reset the interval timer.
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
import { runDetached } from '../helpers/run-detached.js';

const logger = createLogger({ prefix: 'scheduled-job' });

/** Every orchestrator scheduled-job name; a new periodic job MUST be added here. */
export const OrchestratorScheduledJobName = z.enum([
  'cleanup',
  'orphan-secret-cleanup',
  'token-cleanup',
  'cold-store-archive',
  'cold-store-purge',
  'unroutable-probe',
]);
export type OrchestratorScheduledJobName = z.infer<typeof OrchestratorScheduledJobName>;

/** Access-log action for a tick failure. */
const ACCESS_LOG_ACTION_TICK_FAILURE = 'scheduled_job.tick';
/** Access-log action for a manually triggered off-cadence tick. */
export const ACCESS_LOG_ACTION_TRIGGER = 'scheduled_job.trigger';

export interface OrchestratorScheduledJobOptions {
  name: OrchestratorScheduledJobName;
  /** Tick cadence. Must be > 0. */
  intervalMs: number;
  /** Called per tick; exceptions are caught and metered. */
  handler: () => Promise<void>;
  /** The `actor_id` (with `actor_type='system'`) on failure access-log rows. */
  instanceId: string;
  /** For failure audit rows; without it, failures are logs-only. */
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
  /** Force one off-cadence tick and return its outcome, success or failure. */
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

/** Per-job metric state, for the admin `/api/v1/admin/scheduled-jobs` route. */
export function getOrchestratorJobMetricState(): ReadonlyMap<
  string,
  { consecutiveFailures: number; lastSuccessAt: Date | null; lastFailureAt: Date | null }
> {
  return jobMetricState;
}

/** For the admin trigger-now endpoint; `undefined` when not registered here. */
export function findOrchestratorScheduledJob(
  name: OrchestratorScheduledJobName,
): OrchestratorScheduledJobHandle | undefined {
  return handleRegistry.get(name);
}

/** Tests only: production keeps a stable set of registered jobs. */
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
    // Single-flight per handle: a tick in progress is reused.
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
    runDetached(logger, 'Scheduled job run', () => runOnce(), { job: opts.name });
  }, opts.intervalMs);
  if (opts.unref !== false) {
    timer.unref();
  }

  if (opts.runOnStart === true) {
    // Kick synchronously so startup is responsive.
    runDetached(logger, 'Scheduled job run', () => runOnce(), { job: opts.name });
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
