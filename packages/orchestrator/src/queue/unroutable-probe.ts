import { type Kysely, sql } from 'kysely';
import { ExecutionJobStatus } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { JobQueue, UnroutableCandidate } from './job-queue.js';
import { type CanRouteLabels, classifyUnroutable } from './terminalize-unroutable.js';

const logger = createLogger({ prefix: 'unroutable-probe' });

const TICK_FLOOR_MS = 5_000;
const TICK_CEILING_MS = 30_000;
const DEFAULT_BATCH_LIMIT = 200;

/**
 * The shipped default grace, mirrored from `config.ts`. Only derives a tick
 * cadence when the env default is 0 (fast-fail disabled at startup but
 * re-enableable live via the `unroutable_grace_ms` cluster setting).
 */
export const DEFAULT_UNROUTABLE_GRACE_MS = 120_000;

/**
 * Probe cadence, derived from the grace. The tick only has to be fine-grained
 * enough that the grace elapses on time; it is not independent policy, so it
 * deliberately has no cluster knob of its own.
 */
export function probeTickIntervalMs(graceMs: number): number {
  return Math.min(TICK_CEILING_MS, Math.max(TICK_FLOOR_MS, Math.floor(graceMs / 4)));
}

/** Writes the operator-facing routing reason onto a still-queued job. */
export type SetRoutingReason = (
  runId: string,
  jobName: string,
  reason: string | null,
) => Promise<void>;

export interface UnroutableProbeDeps {
  queue: Pick<
    JobQueue,
    'listUnroutableCandidates' | 'markUnroutableSince' | 'clearUnroutableState' | 'claimUnroutable'
  >;
  /** Live read, so an operator changing the knob takes effect without a restart. */
  getGraceMs: () => Promise<number>;
  canRouteLabels: CanRouteLabels;
  setRoutingReason: SetRoutingReason;
  terminalize: (job: UnroutableCandidate) => Promise<void>;
  onFastFailed?: () => void;
  /** Max rows examined per tick. */
  batchLimit?: number;
}

/**
 * The status guard matters: the reason describes a job not yet picked up, so it
 * must never annotate one that started or finished between the probe's read
 * and this write.
 */
export function makeRoutingReasonWriter(db: Kysely<Database>): SetRoutingReason {
  return async (runId, jobName, reason) => {
    await db
      .updateTable('execution_jobs')
      .set({ routing_reason: reason })
      .where('run_id', '=', sql<string>`${runId}::uuid`)
      .where('job_name', '=', jobName)
      .where('status', 'in', [ExecutionJobStatus.enum.pending, ExecutionJobStatus.enum.queued])
      .execute();
  };
}

/**
 * The per-tick handler. It uses the SAME routability predicate as the
 * queue-expiry sweep, on a short tick instead of once an hour. The first
 * unroutable verdict records the reason (visible while the job still waits) and
 * starts a grace clock; only a job CONTINUOUSLY unroutable for the whole grace
 * is terminalized. A job that reads routable again has both cleared, so a
 * scaler reload or agent reconnect never costs it its place in the queue.
 */
export function createUnroutableProbeHandler(deps: UnroutableProbeDeps): () => Promise<void> {
  return async () => {
    const graceMs = await deps.getGraceMs();
    // Disabled at runtime as well as at registration, so flipping the knob to 0
    // on a live cluster takes effect on the next tick.
    if (graceMs <= 0) return;

    const candidates = await deps.queue.listUnroutableCandidates(
      deps.batchLimit ?? DEFAULT_BATCH_LIMIT,
    );
    const now = Date.now();

    for (const job of candidates) {
      const verdict = classifyUnroutable(job, deps.canRouteLabels);

      if (!verdict.unroutable) {
        // Routable now (or a provisioning error settled it): drop any stale
        // grace clock + reason.
        if (job.unroutableSince !== null) {
          await deps.queue.clearUnroutableState(job.id);
          await deps.setRoutingReason(job.runId, job.jobName, null);
          logger.info('Job became routable again; cleared unroutable state', {
            runId: job.runId,
            jobName: job.jobName,
          });
        }
        continue;
      }

      if (job.unroutableSince === null) {
        await deps.queue.markUnroutableSince(job.id, new Date(now));
        await deps.setRoutingReason(job.runId, job.jobName, verdict.errorMessage);
        logger.warn('Job is unroutable; starting grace window', {
          runId: job.runId,
          jobName: job.jobName,
          graceMs,
          reason: verdict.errorMessage,
        });
        continue;
      }

      if (now - job.unroutableSince.getTime() >= graceMs) {
        // Take the row out of `Pending` FIRST, as the expiry sweep does. It is
        // the concurrency arbiter (ticks are not leader-gated, so only one
        // coordinator's UPDATE lands) and stops the job being re-listed,
        // re-terminalized and re-counted every tick until the queue timeout. A
        // row left pending is also still dispatchable to a later agent.
        if (!(await deps.queue.claimUnroutable(job.id))) continue;

        await deps.terminalize(job);
        deps.onFastFailed?.();
        logger.warn('Job stayed unroutable for the whole grace window; failed it', {
          runId: job.runId,
          jobName: job.jobName,
          graceMs,
        });
      }
    }
  };
}
