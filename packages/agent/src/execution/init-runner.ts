import type { $ as Shell } from 'zx';
import type { Workflow, Job, RepoInfo } from '@kici-dev/sdk';
import { isDynamicJobFn } from '@kici-dev/sdk';
import { createFilterContext } from '@kici-dev/sdk/internal';
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
import { evaluateDeferredPaths } from './deferred-paths.js';

/** Only fields flagged dynamic and successfully resolved are set. */
export interface InitResult {
  /** Resolved bound-context names, in merge order (one per `contexts` element). */
  contextNames?: string[];
  env?: Record<string, string>;
  concurrencyGroup?: string;
  /** Dynamic-matrix combinations; the orchestrator re-materializes them into N execution jobs at dispatch. */
  matrixValues?: MatrixValues[];
  /**
   * Workflow-level `filter` verdict, set only under `flags.hasFilter`; `false`
   * means the job must not be dispatched. Optional on purpose: an agent that
   * predates the filter never sets it, and the orchestrator reads absence as
   * "no verdict", never as "suppress".
   */
  filterPassed?: boolean;
  /**
   * Deferred `paths` verdict, set only under `flags.deferredPaths`; `false`
   * means the clone's diff matched none and the job must not be dispatched.
   * Optional for the same older-agent reason as `filterPassed`.
   */
  pathsPassed?: boolean;
}

/**
 * What a workflow-level `filter` needs beyond the module and the event. The
 * caller supplies it: the source tree lives wherever the init job materialized
 * it, and the diff is ground truth from that same clone.
 */
export interface FilterEvalInput {
  /** The repo whose event triggered this evaluation. */
  sourceRepo: RepoInfo;
  /** The repo that registered the workflow — the same repo as `sourceRepo` unless the workflow is global. */
  workflowRepo: RepoInfo;
  changedFiles: string[];
  changedFilesStatus: ChangedFilesStatus;
  env?: Record<string, string | undefined>;
  /** zx shell handed to the filter. Defaults to the ambient `$`. */
  $?: typeof Shell;
}

/**
 * Shared by both agent-side evaluation sites for a same-repo workflow (the init
 * job gating each static job's dispatch, and the dynamic-eval job gating whether
 * a generator runs), so both reach the same verdict from the same inputs.
 *
 * `createFilterContext`, not an object literal: it installs `changedFiles` as a
 * throwing getter, so a filter reading the diff on an event without one fails
 * loudly instead of seeing an empty list that would wrongly suppress every job.
 * On this same-repo path the verdict is recoverable (the run row with its
 * `__init__*` jobs exists, and the step log records it); the organization-wide
 * path, which runs elsewhere, leaves nothing behind.
 *
 * A throwing filter propagates and fails the run: "could not decide" is never
 * "do not run", which would be a false green (the same reasoning
 * `buildJobRuleCompletion` applies to a throwing `check()`).
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

/** Skips dynamic job functions (factories). */
function findJobByName(workflow: Workflow, jobName: string): Job {
  for (const item of workflow.jobs) {
    if (!isDynamicJobFn(item) && (item as Job).name === jobName) {
      return item as Job;
    }
  }
  throw new Error(`Job '${jobName}' not found in workflow '${workflow.name}'`);
}

/**
 * Evaluates a job's dynamic fields (matrix, context, env, concurrencyGroup):
 * only those whose flag is set. A throwing function propagates (the job fails);
 * an undefined/null return leaves the field unset; each call has its own timeout.
 *
 * Deferred `paths` are decided FIRST (`flags.deferredPaths`, from the diff in
 * `filterInput`); a no-match returns before the filter, since the workflow never
 * triggered. The `filter` follows (`flags.hasFilter`); a `false` verdict returns
 * immediately, since no job of the workflow dispatches and evaluating dynamic
 * fields would run customer code whose result nothing consumes.
 *
 * @param event - Normalized event envelope, the shape every dynamic-function call site receives.
 * @param timeoutMs - Per dynamic function call.
 * @param filterInput - Source tree + diff for `filter` and deferred `paths`; required when either is set.
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
    /** The `paths` lists the orchestrator could only match conservatively. */
    deferredPaths?: string[][];
  },
  timeoutMs: number = 60_000,
  filterInput?: FilterEvalInput,
): Promise<InitResult> {
  const result: InitResult = {};

  if (flags.deferredPaths && flags.deferredPaths.length > 0) {
    if (!filterInput) {
      throw new Error(
        `Workflow '${workflow.name}' has deferred paths but the evaluating job supplied no ` +
          `changed files to decide them against.`,
      );
    }
    result.pathsPassed = evaluateDeferredPaths(flags.deferredPaths, {
      files: filterInput.changedFiles,
      status: filterInput.changedFilesStatus,
    });
    if (!result.pathsPassed) return result;
  }

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
    // `resolved` is arbitrary customer runtime data: count before expanding so an
    // oversized matrix fails with a typed error instead of exhausting the agent,
    // and name the job so the failure is diagnosable from the job log.
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
    // Static elements verbatim, functions evaluated, in order; `context` and
    // `contexts` normalize to one ordered list.
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
