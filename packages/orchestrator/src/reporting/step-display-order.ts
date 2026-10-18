/**
 * The order a run's steps are shown in.
 *
 * Sorting `execution_steps` by `step_index` alone puts a pseudo-step where its index landed,
 * not where it ran. That suits the cache pseudo-steps (indices above the real steps, mostly
 * bracketing the work), but a job's image build and its init commands run strictly FIRST.
 *
 * The index cannot express this: `step.status` rejects a negative index (an agent sending one
 * to an older orchestrator is disconnected mid-job), and the check-run reporter
 * (`steps[stepIndex]`) and the dashboard (log fetching gated on `stepIndex >= 0`) treat a
 * negative index as absent. So the ordering is expressed by TYPE, as the engine's
 * `StepPhase`, here, once.
 */

import { sql, type Expression } from 'kysely';
import {
  INIT_STEP_TYPE_PREFIX,
  SetupStepType,
  StepPhase,
  compareStepsByPhase,
} from '@kici-dev/engine';

/**
 * Sort key placing steps by `StepPhase`: setup pseudo-steps, then init commands, then the
 * job's steps. Apply BEFORE the `step_index` sort:
 *
 * ```ts
 * qb.orderBy(setupStepsFirst()).orderBy('step_index', 'asc')
 * ```
 *
 * Untyped steps and every real step share one key, so `step_index` alone orders each group.
 * The init pattern matches `initStepIndex`: the prefix followed by digits only.
 */
export function setupStepsFirst(): Expression<number> {
  const setupTypes = SetupStepType.options;
  const initPattern = `^${INIT_STEP_TYPE_PREFIX}[0-9]+$`;
  return sql<number>`case when step_type in (${sql.join(
    setupTypes.map((t) => sql.lit(t)),
  )}) then ${sql.lit(StepPhase.options.indexOf(StepPhase.enum.setup))} when step_type ~ ${sql.lit(
    initPattern,
  )} then ${sql.lit(StepPhase.options.indexOf(StepPhase.enum.init))} else ${sql.lit(
    StepPhase.options.indexOf(StepPhase.enum.steps),
  )} end`;
}

/** In-memory equivalent over DB rows, kept beside the SQL so the two agree on the phases. */
export function compareStepsForDisplay(
  a: { step_type?: string | null; step_index: number },
  b: { step_type?: string | null; step_index: number },
): number {
  return compareStepsByPhase(
    { stepType: a.step_type, stepIndex: a.step_index },
    { stepType: b.step_type, stepIndex: b.step_index },
  );
}

/** {@link compareStepsForDisplay} over untyped rows, such as cold-store rows read back from S3. */
export function compareStepRowsForDisplay(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const typed = (r: Record<string, unknown>) => ({
    step_type: typeof r.step_type === 'string' ? r.step_type : null,
    step_index: Number(r.step_index ?? 0),
  });
  return compareStepsForDisplay(typed(a), typed(b));
}
