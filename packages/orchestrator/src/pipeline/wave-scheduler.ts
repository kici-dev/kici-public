/**
 * Rolling-wave scheduler for bounded fan-out (`maxParallel` / `failFast`).
 *
 * Sibling of the needs-scheduler (`needs-scheduler.ts`): both fire on a job
 * reaching terminal state and decide what to do with held downstream/sibling
 * jobs. The needs-scheduler releases jobs whose `needs` edges are now satisfied;
 * the wave-scheduler releases the next `wave_gated` sibling of a fan-out base
 * whenever an in-flight slot frees up (or, under `failFast`, skips the held
 * remainder on the first child failure).
 *
 * Pure DB — no in-memory state. Every decision is a fresh query against
 * `execution_jobs` keyed by `(run_id, base_job_name)`, so the scheduler needs
 * zero recovery code on orchestrator restart. The caller performs the DB write
 * (clear `wave_gated` / mark skipped) and the dispatch (`onJobReady`), keeping
 * this module a pure decision function.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { TERMINAL_JOB_STATES, ExecutionJobStatus } from '@kici-dev/engine';

/** Inputs identifying a completed fan-out child. The wave policy is read from the base group. */
export interface WaveEvaluation {
  runId: string;
  /** The base (logical) job name shared by every fan-out child. */
  baseJobName: string;
  /** Terminal status of the child that just completed. */
  completedStatus: string;
}

/** The wave-scheduler's decision for one completed child. */
export type WaveResult =
  | {
      action: 'release';
      jobName: string;
      baseJobName: string;
      maxParallel: number;
      failFast: boolean;
    }
  | { action: 'skip-remaining'; jobNames: string[] }
  | { action: 'noop' };

/**
 * Decide what happens after a fan-out child of `baseJobName` reaches terminal.
 *
 * The wave policy (`maxParallel` / `failFast`) is read from the base group's
 * own rows — every child of a bounded wave carries the same stamped
 * `wave_max_parallel` / `wave_fail_fast`, so the just-completed child's slot
 * being re-inserted without the policy on release does not break the chain
 * (the still-held siblings carry it). If no sibling carries a policy, this is
 * not a bounded wave → `noop`.
 *
 * - `failFast` + a child failure → `skip-remaining` every still-held sibling.
 * - in-flight count `< maxParallel` AND a held sibling exists → `release` the
 *   next held sibling (lowest `variant_label`).
 * - otherwise → `noop`.
 *
 * "In-flight" = a non-terminal, non-`wave_gated` child (it has been dispatched
 * and not yet completed). The just-completed child is terminal, so it does not
 * count against the window — its slot is the one we are filling.
 */
export async function evaluateWave(
  db: Kysely<Database>,
  evaluation: WaveEvaluation,
): Promise<WaveResult> {
  const { runId, baseJobName, completedStatus } = evaluation;

  const children = await db
    .selectFrom('execution_jobs')
    .select([
      'job_name',
      'status',
      'wave_gated',
      'variant_label',
      'wave_max_parallel',
      'wave_fail_fast',
    ])
    .where('run_id', '=', runId)
    .where('base_job_name', '=', baseJobName)
    .execute();

  // Recover the wave policy from any sibling carrying it (they all share it).
  const policyRow = children.find((c) => c.wave_max_parallel != null);
  if (!policyRow || policyRow.wave_max_parallel == null) return { action: 'noop' };
  const maxParallel = policyRow.wave_max_parallel;
  const failFast = policyRow.wave_fail_fast ?? false;

  const heldSiblings = children
    .filter((c) => c.wave_gated)
    .sort((a, b) => (a.variant_label ?? a.job_name).localeCompare(b.variant_label ?? b.job_name));

  // failFast: a failing child halts the roll — skip every still-held sibling.
  const isFailure = completedStatus !== ExecutionJobStatus.enum.success;
  if (failFast && isFailure) {
    if (heldSiblings.length === 0) return { action: 'noop' };
    return { action: 'skip-remaining', jobNames: heldSiblings.map((c) => c.job_name) };
  }

  if (heldSiblings.length === 0) return { action: 'noop' };

  // Count children currently occupying a wave slot: dispatched (non-terminal)
  // and NOT themselves held. If that is still at the cap, do nothing — a later
  // terminal will free the slot.
  const inFlight = children.filter(
    (c) => !c.wave_gated && !TERMINAL_JOB_STATES.has(c.status),
  ).length;
  if (inFlight >= maxParallel) return { action: 'noop' };

  return {
    action: 'release',
    jobName: heldSiblings[0].job_name,
    baseJobName,
    maxParallel,
    failFast,
  };
}
