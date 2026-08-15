import type { $ as Shell } from 'zx';
import type { Workflow, Job, RepoInfo } from '@kici-dev/sdk';
import { isDynamicJobFn, createFilterContext } from '@kici-dev/sdk';
import {
  expandMatrix,
  applyIncludeExclude,
  matrixCombinationCount,
  MatrixShapeError,
  MAX_MATRIX_MATERIALIZATION,
  type ChangedFilesStatus,
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
  /**
   * Verdict of the workflow-level `filter`, set only when the init job was asked
   * to evaluate one (`flags.hasFilter`). `false` means the workflow does not
   * apply and its job must not be dispatched.
   *
   * Optional on purpose: an agent that predates the filter never sets it, so the
   * orchestrator reads absence as "no verdict was reported", never as "suppress".
   */
  filterPassed?: boolean;
}

/**
 * Everything a workflow-level `filter` needs beyond the workflow module and the
 * event. Supplied by the caller because none of it is derivable here: the source
 * tree lives wherever the init job materialized it, and the diff is ground truth
 * from that same clone.
 */
export interface FilterEvalInput {
  /** The repo whose event triggered this evaluation. */
  sourceRepo: RepoInfo;
  /** The repo that registered the workflow — identical to `sourceRepo` here. */
  workflowRepo: RepoInfo;
  changedFiles: string[];
  changedFilesStatus: ChangedFilesStatus;
  env?: Record<string, string | undefined>;
  /** zx shell handed to the filter. Defaults to the ambient `$`. */
  $?: typeof Shell;
}

/**
 * Run a workflow's `filter` and report whether the workflow applies.
 *
 * Shared by both agent-side evaluation sites for a same-repo workflow: the init
 * job that gates each static job's dispatch, and the dynamic-eval job that gates
 * whether a generator runs at all. Both must reach the same verdict from the same
 * inputs, so neither builds the context itself.
 *
 * The context is built through `createFilterContext` rather than as an object
 * literal: the factory installs `changedFiles` as a throwing getter, so a filter
 * that reads the diff on an event that has none fails loudly instead of seeing an
 * empty list. A `false` verdict dispatches none of the workflow's own jobs, so a
 * silently-empty diff would suppress it on a mistake. On this same-repo path the
 * verdict is at least recoverable — the run row exists, carrying the `__init__*`
 * jobs, and this evaluation's own step log records the verdict; it is the
 * organization-wide path, which runs elsewhere, that leaves nothing behind.
 *
 * A throwing filter propagates: the evaluating job fails, which surfaces as a
 * failed run. "Could not decide" is never treated as "do not run" — that would
 * be a false green, the same reasoning `buildJobRuleCompletion` applies to a rule
 * whose `check()` threw.
 */
export async function evaluateWorkflowFilter(
  workflow: Workflow,
  event: Record<string, unknown>,
  input: FilterEvalInput | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof workflow.filter !== 'function') {
    throw new Error(
      `Workflow '${workflow.name}' is recorded as declaring a filter, but its module ` +
        `exports none — the lock file is out of date. Run 'kici compile' and commit the result.`,
    );
  }
  if (!input) {
    throw new Error(
      `Workflow '${workflow.name}' declares a filter but the evaluating job supplied no ` +
        `filter context (source tree / changed files) to evaluate it against.`,
    );
  }
  const filterFn = workflow.filter;
  const ctx = createFilterContext({
    sourceRepo: input.sourceRepo,
    workflowRepo: input.workflowRepo,
    event,
    changedFiles: input.changedFiles,
    changedFilesStatus: input.changedFilesStatus,
    ...(input.env && { env: input.env }),
    ...(input.$ && { $: input.$ }),
  });
  const verdict = await withTimeout(
    () => filterFn(ctx),
    timeoutMs,
    `filter for workflow '${workflow.name}'`,
  );
  return Boolean(verdict);
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
 * A workflow-level `filter` is evaluated FIRST when `flags.hasFilter` is set. A
 * `false` verdict returns immediately: no job of that workflow will be
 * dispatched, so evaluating this one's dynamic fields would run customer code
 * whose result nothing can consume.
 *
 * @param workflow - The extracted Workflow object
 * @param jobName - Name of the job whose dynamic fields to evaluate
 * @param event - Normalized event envelope — same shape every dynamic-function call site receives.
 * @param flags - Which fields are dynamic and need evaluation
 * @param timeoutMs - Timeout per dynamic function call (default 60_000ms)
 * @param filterInput - Source tree + diff the workflow's `filter` reads. Required when `flags.hasFilter`.
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
    hasFilter?: boolean;
  },
  timeoutMs: number = 60_000,
  filterInput?: FilterEvalInput,
): Promise<InitResult> {
  const result: InitResult = {};

  if (flags.hasFilter) {
    result.filterPassed = await evaluateWorkflowFilter(workflow, event, filterInput, timeoutMs);
    if (!result.filterPassed) return result;
  }

  const job = findJobByName(workflow, jobName);

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
