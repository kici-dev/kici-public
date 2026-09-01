/**
 * The order a run's steps are shown in.
 *
 * Every reader of `execution_steps` sorted by `step_index` alone, which puts a
 * pseudo-step wherever its index landed rather than where it ran. That is fine
 * for the cache pseudo-steps, whose indices sit above the real steps and which
 * mostly bracket the work — but a job's image build runs strictly FIRST, and
 * rendering it last reads as though it happened last.
 *
 * The index cannot express this: `step.status` rejects a negative index (an
 * agent sending one to an older orchestrator is disconnected mid-job), and two
 * consumers treat a negative index as absent — the check-run reporter writes
 * `steps[stepIndex]`, and the dashboard gates log fetching on `stepIndex >= 0`.
 * So the ordering is expressed by TYPE, here, once, rather than by each reader
 * inventing its own rule.
 */

import { sql, type Expression } from 'kysely';
import { SetupStepType } from '@kici-dev/engine';

/**
 * Sort key placing setup pseudo-steps (the ones that ran before the job's real
 * steps) ahead of everything else. Apply BEFORE the `step_index` sort:
 *
 * ```ts
 * qb.orderBy(setupStepsFirst()).orderBy('step_index', 'asc')
 * ```
 *
 * Steps with no type, and every real step, share the same key — so within each
 * group `step_index` remains the only thing that orders them, exactly as before.
 */
export function setupStepsFirst(): Expression<number> {
  const setupTypes = SetupStepType.options;
  return sql<number>`case when step_type in (${sql.join(
    setupTypes.map((t) => sql.lit(t)),
  )}) then 0 else 1 end`;
}

/**
 * In-memory equivalent, for a caller that already holds the rows.
 *
 * Kept beside the SQL so the two cannot drift into disagreeing about what
 * "setup" means.
 */
export function compareStepsForDisplay(
  a: { step_type?: string | null; step_index: number },
  b: { step_type?: string | null; step_index: number },
): number {
  const rank = (s: { step_type?: string | null }): number =>
    s.step_type != null && (SetupStepType.options as readonly string[]).includes(s.step_type)
      ? 0
      : 1;
  const byRank = rank(a) - rank(b);
  return byRank !== 0 ? byRank : a.step_index - b.step_index;
}
