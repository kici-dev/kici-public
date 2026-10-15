/**
 * The order a run's steps are shown in.
 *
 * Sorting `execution_steps` by `step_index` alone puts a pseudo-step where its index landed,
 * not where it ran. That suits the cache pseudo-steps (indices above the real steps, mostly
 * bracketing the work), but a job's image build runs strictly FIRST.
 *
 * The index cannot express this: `step.status` rejects a negative index (an agent sending one
 * to an older orchestrator is disconnected mid-job), and the check-run reporter
 * (`steps[stepIndex]`) and the dashboard (log fetching gated on `stepIndex >= 0`) treat a
 * negative index as absent. So the ordering is expressed by TYPE, here, once.
 */

import { sql, type Expression } from 'kysely';
import { SetupStepType } from '@kici-dev/engine';

/**
 * Sort key placing setup pseudo-steps (run before the job's real steps) first. Apply BEFORE
 * the `step_index` sort:
 *
 * ```ts
 * qb.orderBy(setupStepsFirst()).orderBy('step_index', 'asc')
 * ```
 *
 * Untyped steps and every real step share one key, so `step_index` alone orders each group.
 */
export function setupStepsFirst(): Expression<number> {
  const setupTypes = SetupStepType.options;
  return sql<number>`case when step_type in (${sql.join(
    setupTypes.map((t) => sql.lit(t)),
  )}) then 0 else 1 end`;
}

/** In-memory equivalent, kept beside the SQL so the two agree on what "setup" means. */
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
