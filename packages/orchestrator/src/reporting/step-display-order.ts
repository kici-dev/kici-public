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
  INIT_STEP_INDEX_BASE,
  INIT_STEP_TYPE_PREFIX,
  SetupStepType,
  StepPhase,
  UNTYPED_STEP_TYPE,
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
 * The init match is the engine's `stepInitIndex`: an `init:<n>` type (the prefix followed by
 * digits only), or an untyped row at `INIT_STEP_INDEX_BASE + n` named `init:<n>`.
 */
export function setupStepsFirst(): Expression<number> {
  const setupTypes = SetupStepType.options;
  const initPattern = `^${INIT_STEP_TYPE_PREFIX}[0-9]+$`;
  const base = sql.lit(INIT_STEP_INDEX_BASE);
  const untypedInit = sql`(step_type is null or step_type = ${sql.lit(UNTYPED_STEP_TYPE)}) and step_index >= ${base} and step_name = (${sql.lit(INIT_STEP_TYPE_PREFIX)} || (step_index - ${base})::text)`;
  return sql<number>`case when step_type in (${sql.join(
    setupTypes.map((t) => sql.lit(t)),
  )}) then ${sql.lit(StepPhase.options.indexOf(StepPhase.enum.setup))} when step_type ~ ${sql.lit(
    initPattern,
  )} or (${untypedInit}) then ${sql.lit(StepPhase.options.indexOf(StepPhase.enum.init))} else ${sql.lit(
    StepPhase.options.indexOf(StepPhase.enum.steps),
  )} end`;
}

/** A stored step row, as the run readers select it. */
interface StepRow {
  step_type?: string | null;
  step_index: number;
  step_name?: string | null;
}

/** In-memory equivalent over DB rows, kept beside the SQL so the two agree on the phases. */
export function compareStepsForDisplay(a: StepRow, b: StepRow): number {
  return compareStepsByPhase(
    { stepType: a.step_type, stepIndex: a.step_index, stepName: a.step_name },
    { stepType: b.step_type, stepIndex: b.step_index, stepName: b.step_name },
  );
}

/** {@link compareStepsForDisplay} over untyped rows, such as cold-store rows read back from S3. */
export function compareStepRowsForDisplay(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const typed = (r: Record<string, unknown>): StepRow => ({
    step_type: typeof r.step_type === 'string' ? r.step_type : null,
    step_index: Number(r.step_index ?? 0),
    step_name: typeof r.step_name === 'string' ? r.step_name : null,
  });
  return compareStepsForDisplay(typed(a), typed(b));
}
