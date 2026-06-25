/**
 * Serializes SDK Job[] objects returned by a DynamicJobFn into LockJob[] format.
 *
 * This is the runtime equivalent of the compiler's transformJob() in lockfile/generator.ts.
 * It converts rich SDK Job objects (with function references) into the minimal lock file
 * representation that the orchestrator can process.
 *
 * Dynamic env/environment/concurrencyGroup/matrix functions on generated jobs are
 * evaluated inline against the eval context (the same `event`, `$`, `log`, `env`
 * already passed to the parent DynamicJobFn) and embedded as static lock fields.
 * Each dynamic function call is wrapped in `withTimeout` (default 60s) mirroring
 * `init-runner.ts`. Functions returning `undefined`/`null` leave the field unset.
 *
 * Constraints:
 * - Generated jobs are limited to MAX_DYNAMIC_JOBS per DynamicJobFn invocation
 * - Generated job names must be unique within the same DynamicJobFn output
 */

import type { $ as Shell } from 'zx';
import type {
  Job,
  Step,
  Logger,
  DynamicMatrixFn,
  DynamicMatrixContext,
  NeedsWhenInput,
} from '@kici-dev/sdk';
import { isDynamicJobFn, isDynamicGroupRef, isStaticArray, isStaticObject } from '@kici-dev/sdk';
import type { DynamicGroupRef } from '@kici-dev/sdk';
import type {
  LockJob,
  LockStep,
  LockMatrix,
  NeedsEntry,
  NeedsGroupEntry,
  LabelMatcher,
} from '@kici-dev/engine';
import { normalizeRunsOnToMatchers } from '@kici-dev/engine/labels/compile';
import { resolveWhenToRunOn } from '@kici-dev/engine';
import { withTimeout } from './timeout-util.js';

/**
 * Thrown when resolving a job's dynamic matrix fails (the matrix function threw
 * or timed out, or returned an unsupported value). Lets the agent attribute the
 * failure to the matrix_expansion init-failure category instead of the generic
 * dynamic_eval bucket.
 */
export class MatrixExpansionError extends Error {
  readonly name = 'MatrixExpansionError';
  constructor(
    readonly jobName: string,
    message: string,
  ) {
    super(message);
    // Restore prototype chain for instanceof across the transpile boundary.
    Object.setPrototypeOf(this, MatrixExpansionError.prototype);
  }
}

/** Maximum number of jobs a single DynamicJobFn can generate. */
export const MAX_DYNAMIC_JOBS = 100;

/** Default per-call timeout for evaluating dynamic env/matrix functions on generated jobs. */
const DYNAMIC_FIELD_TIMEOUT_MS = 60_000;

/**
 * Context required to resolve dynamic env/environment/concurrencyGroup/matrix
 * functions on generated jobs. The eval agent already has every field needed
 * (it's the same context that was just passed to the parent DynamicJobFn), so
 * we thread it through the serializer rather than re-creating it.
 */
export interface SerializerContext {
  /** Normalized event envelope — passed as the first argument to env/environment/concurrencyGroup fns. */
  event: Record<string, unknown>;
  /** zx shell — passed to dynamic matrix fns. */
  $: typeof Shell;
  /** Logger — passed to dynamic matrix fns. */
  log: Logger;
  /** Environment variables — passed to dynamic matrix fns. */
  env: Record<string, string | undefined>;
  /** Workflow name — surfaced through DynamicMatrixContext.ctx.workflow.name. */
  workflowName: string;
}

/**
 * Convert an array of SDK Job objects into LockJob format for the orchestrator.
 *
 * @param jobs - Jobs returned by a DynamicJobFn
 * @param ctx - Eval-time context used to resolve dynamic fields on generated jobs
 * @returns Serialized LockJob array ready for orchestrator dispatch
 * @throws Error if validation fails (duplicates, limit exceeded) or if a user-supplied
 *   dynamic function throws / times out / returns an unsupported value
 */
export async function serializeJobsToLock(
  jobs: Job[],
  ctx: SerializerContext,
  staticNames?: Set<string>,
  allowedGroups?: Set<string>,
): Promise<LockJob[]> {
  if (jobs.length > MAX_DYNAMIC_JOBS) {
    throw new Error(
      `DynamicJobFn generated ${jobs.length} jobs, exceeding the limit of ${MAX_DYNAMIC_JOBS}`,
    );
  }

  // Validate unique names
  const generatedNames = new Set<string>();
  for (const job of jobs) {
    if (generatedNames.has(job.name)) {
      throw new Error(`Duplicate job name '${job.name}' in DynamicJobFn output`);
    }
    generatedNames.add(job.name);
  }

  // Resolve sequentially to keep determinism (ordering + error attribution).
  const result: LockJob[] = [];
  for (const job of jobs) {
    result.push(
      await serializeJob(
        job,
        generatedNames,
        ctx,
        staticNames ?? new Set(),
        allowedGroups ?? new Set(),
      ),
    );
  }
  return result;
}

async function serializeJob(
  job: Job,
  generatedNames: Set<string>,
  ctx: SerializerContext,
  staticNames: Set<string>,
  allowedGroups: Set<string>,
): Promise<LockJob> {
  const { include: runsOn, exclude: excludeLabels } = normalizeRunsOnToMatchers(
    job.runsOn as never,
    `generated job '${job.name}' runsOn`,
  );

  // Resolve dynamic environment/env/concurrencyGroup against the eval context.
  let resolvedEnvironment: string | undefined;
  if (typeof job.environment === 'function') {
    const value = await withTimeout(
      () =>
        (job.environment as (event: Record<string, unknown>) => string | Promise<string>)(
          ctx.event,
        ),
      DYNAMIC_FIELD_TIMEOUT_MS,
      `dynamic environment for generated job '${job.name}'`,
    );
    if (value !== undefined && value !== null) {
      resolvedEnvironment = value;
    }
  } else if (typeof job.environment === 'string') {
    resolvedEnvironment = job.environment;
  }

  let resolvedEnv: Record<string, string> | undefined;
  if (typeof job.env === 'function') {
    const value = await withTimeout(
      () =>
        (
          job.env as (
            event: Record<string, unknown>,
          ) => Record<string, string> | Promise<Record<string, string>>
        )(ctx.event),
      DYNAMIC_FIELD_TIMEOUT_MS,
      `dynamic env for generated job '${job.name}'`,
    );
    if (value !== undefined && value !== null) {
      resolvedEnv = value;
    }
  } else if (job.env && typeof job.env === 'object') {
    resolvedEnv = job.env as Record<string, string>;
  }

  let resolvedConcurrencyGroup: string | undefined;
  if (typeof job.concurrencyGroup === 'function') {
    const value = await withTimeout(
      () =>
        (job.concurrencyGroup as (event: Record<string, unknown>) => string | Promise<string>)(
          ctx.event,
        ),
      DYNAMIC_FIELD_TIMEOUT_MS,
      `dynamic concurrencyGroup for generated job '${job.name}'`,
    );
    if (value !== undefined && value !== null) {
      resolvedConcurrencyGroup = value;
    }
  } else if (typeof job.concurrencyGroup === 'string') {
    resolvedConcurrencyGroup = job.concurrencyGroup;
  }

  const resolvedMatrix = job.matrix
    ? await serializeMatrix(job.matrix, job.name, runsOn, ctx)
    : undefined;

  const resolvedNeeds = resolveNeeds(job.needs, generatedNames, staticNames, allowedGroups);

  // Extract dependsOnGroups from resolved needs (NeedsGroupEntry items)
  const dependsOnGroups = resolvedNeeds
    .filter((n): n is NeedsGroupEntry => typeof n === 'object' && 'group' in n)
    .map((n) => n.group);

  const lockJob: LockJob = {
    _type: 'static',
    name: job.name,
    runsOn,
    ...(excludeLabels.length > 0 ? { excludeLabels } : {}),
    needs: resolvedNeeds,
    ...(dependsOnGroups.length > 0 ? { dependsOnGroups } : {}),
    steps: serializeSteps(job.steps),
    ...(resolvedMatrix ? { matrix: resolvedMatrix } : {}),
    ...(job.include ? { include: job.include } : {}),
    ...(job.exclude ? { exclude: job.exclude } : {}),
    ...(job.description ? { description: job.description } : {}),
    ...(resolvedEnvironment !== undefined ? { environment: resolvedEnvironment } : {}),
    ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
    ...(resolvedConcurrencyGroup !== undefined
      ? { concurrencyGroup: resolvedConcurrencyGroup }
      : {}),
  };

  return lockJob;
}

/**
 * Resolve needs references. Jobs can reference other jobs by name (string),
 * Job object reference, DynamicGroupRef, or NeedsEntry/NeedsGroupEntry objects.
 * Validates against generatedNames union staticNames union allowedGroups.
 *
 * Returns the lock file representation: strings for concrete refs,
 * NeedsEntry for { name, when }, NeedsGroupEntry for group refs (each `when`
 * normalized to a runOn status-set).
 */
function resolveNeeds(
  needs: Job['needs'],
  generatedNames: Set<string>,
  staticNames: Set<string>,
  allowedGroups: Set<string>,
): readonly (string | NeedsEntry | NeedsGroupEntry)[] {
  if (!needs || needs.length === 0) return [];

  const allNames = new Set([...generatedNames, ...staticNames]);

  return needs.map((dep) => {
    // String reference: check against generated + static names
    if (typeof dep === 'string') {
      if (!allNames.has(dep)) {
        throw new Error(
          `Job dependency '${dep}' not found in workflow jobs ` +
            `(checked: ${generatedNames.size} generated, ${staticNames.size} static)`,
        );
      }
      return dep;
    }

    // DynamicGroupRef: validate group name is in allowedGroups
    if (isDynamicGroupRef(dep)) {
      const groupRef = dep as DynamicGroupRef;
      if (!allowedGroups.has(groupRef.group)) {
        throw new Error(
          `Dynamic group '${groupRef.group}' not found in workflow ` +
            `(available groups: ${[...allowedGroups].join(', ') || 'none'})`,
        );
      }
      // Return as NeedsGroupEntry for the lock file
      return {
        group: groupRef.group,
        runOn: resolveWhenToRunOn(groupRef.when),
      } as NeedsGroupEntry;
    }

    // Object with 'group' field (NeedsGroupEntry-like): validate group name
    if (typeof dep === 'object' && dep !== null && 'group' in dep) {
      const groupDep = dep as { group: string; when?: NeedsWhenInput };
      if (!allowedGroups.has(groupDep.group)) {
        throw new Error(
          `Dynamic group '${groupDep.group}' not found in workflow ` +
            `(available groups: ${[...allowedGroups].join(', ') || 'none'})`,
        );
      }
      return {
        group: groupDep.group,
        runOn: resolveWhenToRunOn(groupDep.when),
      } as NeedsGroupEntry;
    }

    // Object with 'name' field (NeedsEntry-like): validate name
    if (typeof dep === 'object' && dep !== null && 'name' in dep && !('steps' in dep)) {
      const namedDep = dep as { name: string; when?: NeedsWhenInput };
      if (!allNames.has(namedDep.name)) {
        throw new Error(
          `Job dependency '${namedDep.name}' not found in workflow jobs ` +
            `(checked: ${generatedNames.size} generated, ${staticNames.size} static)`,
        );
      }
      return {
        name: namedDep.name,
        runOn: resolveWhenToRunOn(namedDep.when),
      } as NeedsEntry;
    }

    // Job object reference — check it's not a DynamicJobFn
    if (isDynamicJobFn(dep as any)) {
      throw new Error('Job dependency cannot be a DynamicJobFn');
    }
    const name = (dep as Job).name;
    if (!allNames.has(name)) {
      throw new Error(
        `Job dependency '${name}' not found in workflow jobs ` +
          `(checked: ${generatedNames.size} generated, ${staticNames.size} static)`,
      );
    }
    return name;
  });
}

/**
 * Serialize step definitions to lock file format.
 * Steps are minimal in the lock file — just metadata. The actual run functions
 * are loaded from the workflow bundle at execution time.
 */
function serializeSteps(steps: readonly (Step<any> | ((...args: any[]) => any))[]): LockStep[] {
  return steps.map((stepOrFn, index) => {
    // Bare function steps (anonymous)
    if (typeof stepOrFn === 'function') {
      return {
        name: `step-${index}`,
        hasOutputs: false,
      };
    }

    const step = stepOrFn as Step<any>;
    return {
      name: step.name || `step-${index}`,
      hasOutputs: !!step.outputs,
      ...(step.continueOnError ? { continueOnError: true } : {}),
      ...(step.timeout ? { timeout: step.timeout } : {}),
      ...(step.retry
        ? {
            retry: {
              maxAttempts: step.retry.maxAttempts,
              delayMs: step.retry.delayMs,
              backoff: step.retry.backoff,
              maxDelayMs: step.retry.maxDelayMs,
            },
          }
        : {}),
    };
  });
}

/**
 * Serialize matrix configuration. Static array/object matrices are embedded as-is;
 * dynamic matrix functions are invoked against the eval context (mirroring the
 * DynamicMatrixContext signature) and the resulting array/object is embedded.
 */
async function serializeMatrix(
  matrix: NonNullable<Job['matrix']>,
  jobName: string,
  runsOn: readonly LabelMatcher[],
  ctx: SerializerContext,
): Promise<LockMatrix> {
  if (isStaticArray(matrix)) {
    return {
      _type: 'static',
      values: matrix as string[],
    };
  }
  if (isStaticObject(matrix)) {
    return {
      _type: 'static',
      values: matrix as Record<string, readonly string[]>,
    };
  }

  // Dynamic matrix function — invoke against the eval context.
  const matrixCtx: DynamicMatrixContext = {
    $: ctx.$,
    ctx: {
      workflow: { name: ctx.workflowName },
      job: {
        name: jobName,
        runsOn: runsOn.map((m) => (m.kind === 'exact' ? m.value : `/${m.source}/${m.flags}`)),
      },
    },
    log: ctx.log,
    env: ctx.env,
  };

  let values: unknown;
  try {
    values = await withTimeout(
      () => (matrix as DynamicMatrixFn)(matrixCtx),
      DYNAMIC_FIELD_TIMEOUT_MS,
      `dynamic matrix for generated job '${jobName}'`,
    );
  } catch (err) {
    throw new MatrixExpansionError(
      jobName,
      `Matrix expansion failed for job '${jobName}': ${(err as Error).message}`,
    );
  }

  if (Array.isArray(values)) {
    return {
      _type: 'static',
      values: values as string[],
    };
  }
  if (values && typeof values === 'object') {
    return {
      _type: 'static',
      values: values as Record<string, readonly string[]>,
    };
  }
  throw new MatrixExpansionError(
    jobName,
    `Job '${jobName}': dynamic matrix function returned an unsupported value (expected array or object, got ${typeof values})`,
  );
}
