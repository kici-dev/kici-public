import type { Workflow, Job } from '@kici-dev/sdk';
import { isDynamicJobFn } from '@kici-dev/sdk';
import {
  expandMatrix,
  applyIncludeExclude,
  matrixCombinationCount,
  MatrixShapeError,
  MAX_MATRIX_MATERIALIZATION,
  type MatrixValues,
} from '@kici-dev/engine';
import { withTimeout } from './timeout-util.js';

/**
 * Result of evaluating dynamic fields on a job.
 * Only fields that were flagged as dynamic and successfully resolved are set.
 */
export interface InitResult {
  /** Resolved bound-context names, in merge order (one per `contexts` element). */
  contextNames?: string[];
  env?: Record<string, string>;
  concurrencyGroup?: string;
  /**
   * Resolved matrix combinations when the job's matrix is a dynamic function.
   * The orchestrator re-materializes these into N execution jobs at dispatch.
   */
  matrixValues?: MatrixValues[];
}

/**
 * Find a static job by name in a workflow's jobs array.
 * Skips dynamic job functions (factories).
 */
function findJobByName(workflow: Workflow, jobName: string): Job {
  for (const item of workflow.jobs) {
    if (!isDynamicJobFn(item) && (item as Job).name === jobName) {
      return item as Job;
    }
  }
  throw new Error(`Job '${jobName}' not found in workflow '${workflow.name}'`);
}

/**
 * Evaluate dynamic fields (context, env, concurrencyGroup) on a job.
 *
 * Only fields with their corresponding flag set to true AND whose property
 * on the job is a function will be evaluated. All evaluations happen in a
 * single call per.
 *
 * -: If a dynamic function throws, the error propagates (job fails).
 * -: If a dynamic function returns undefined/null, the field is left undefined.
 * -: Each dynamic function call is wrapped in a timeout (default 60s).
 *
 * @param workflow - The extracted Workflow object
 * @param jobName - Name of the job whose dynamic fields to evaluate
 * @param event - Normalized event envelope — same shape every dynamic-function call site receives.
 * @param flags - Which fields are dynamic and need evaluation
 * @param timeoutMs - Timeout per dynamic function call (default 60_000ms)
 */
export async function evaluateDynamicFields(
  workflow: Workflow,
  jobName: string,
  event: Record<string, unknown>,
  flags: {
    dynamicContext: boolean;
    dynamicEnv: boolean;
    dynamicConcurrencyGroup: boolean;
    dynamicMatrix?: boolean;
  },
  timeoutMs: number = 60_000,
): Promise<InitResult> {
  const job = findJobByName(workflow, jobName);
  const result: InitResult = {};

  if (flags.dynamicMatrix && typeof job.matrix === 'function') {
    const matrixContext = {
      $: (await import('zx')).$,
      ctx: { workflow: { name: workflow.name }, job: { name: jobName, runsOn: job.runsOn } },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      env: { ...process.env } as Record<string, string | undefined>,
    };
    const resolved = await withTimeout(
      () => (job.matrix as (c: typeof matrixContext) => unknown)(matrixContext),
      timeoutMs,
      `dynamicMatrix for job '${jobName}'`,
    );
    // `resolved` is whatever the customer's matrix function returned — arbitrary
    // runtime data. Count before expanding so an oversized matrix fails with a
    // typed error instead of exhausting the agent, and name the job on the way
    // out so the failure is diagnosable from the job log.
    let combos: MatrixValues[];
    try {
      const rawCount = matrixCombinationCount(resolved);
      if (rawCount > MAX_MATRIX_MATERIALIZATION) {
        throw new MatrixShapeError(
          `matrix is too large to expand: ${rawCount} raw combinations (max ${MAX_MATRIX_MATERIALIZATION})`,
        );
      }
      combos = expandMatrix(resolved);
    } catch (err) {
      if (err instanceof MatrixShapeError) {
        throw new MatrixShapeError(`dynamicMatrix for job '${jobName}': ${err.message}`);
      }
      throw err;
    }
    if (job.include || job.exclude) {
      combos = applyIncludeExclude(combos, job.include, job.exclude);
    }
    result.matrixValues = combos;
  }

  if (flags.dynamicContext) {
    // Resolve every bound-context element in order (static verbatim, dynamic
    // functions evaluated). Either spelling normalizes to one ordered list.
    const envRefs = job.contexts ?? (job.context !== undefined ? [job.context] : undefined);
    if (envRefs && envRefs.length > 0) {
      const names: string[] = [];
      for (const ref of envRefs) {
        if (typeof ref === 'function') {
          const value = await withTimeout(
            () => (ref as (event: Record<string, unknown>) => string | Promise<string>)(event),
            timeoutMs,
            `dynamicContext for job '${jobName}'`,
          );
          if (value !== undefined && value !== null) names.push(value);
        } else if (typeof ref === 'string') {
          names.push(ref);
        }
      }
      if (names.length > 0) result.contextNames = names;
    }
  }

  if (flags.dynamicEnv && typeof job.env === 'function') {
    const value = await withTimeout(
      () =>
        (
          job.env as (
            event: Record<string, unknown>,
          ) => Record<string, string> | Promise<Record<string, string>>
        )(event),
      timeoutMs,
      `dynamicEnv for job '${jobName}'`,
    );
    if (value !== undefined && value !== null) {
      result.env = value;
    }
  }

  if (flags.dynamicConcurrencyGroup && typeof job.concurrencyGroup === 'function') {
    const value = await withTimeout(
      () =>
        (job.concurrencyGroup as (event: Record<string, unknown>) => string | Promise<string>)(
          event,
        ),
      timeoutMs,
      `dynamicConcurrencyGroup for job '${jobName}'`,
    );
    if (value !== undefined && value !== null) {
      result.concurrencyGroup = value;
    }
  }

  return result;
}
