/**
 * Serializes the SDK Job[] a DynamicJobFn returns into LockJob[]: the runtime
 * equivalent of the compiler's transformJob() in lockfile/generator.ts.
 *
 * Dynamic env/environment/concurrencyGroup/matrix functions run inline against
 * the parent DynamicJobFn's eval context, each under `withTimeout` (60s, as in
 * `init-runner.ts`), and embed as static lock fields; `undefined`/`null` leaves
 * the field unset.
 *
 * Constraints: at most MAX_DYNAMIC_JOBS per invocation; names unique within one
 * output, and across an eval round when the caller threads a shared `seenNames`.
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
import {
  isDynamicJobFn,
  isDynamicGroupRef,
  isStaticArray,
  isStaticObject,
  isParallelGroup,
} from '@kici-dev/sdk';
import type { DynamicGroupRef, StepInput } from '@kici-dev/sdk';
import type {
  LockJob,
  LockStep,
  LockParallelStep,
  LockStepEntry,
  LockMatrix,
  NeedsEntry,
  NeedsGroupEntry,
  LabelMatcher,
} from '@kici-dev/engine';
import { normalizeRunsOnToMatchers } from '@kici-dev/engine/labels/compile';
import { formatLabelMatcher, resolveWhenToRunOn } from '@kici-dev/engine';
import { withTimeout } from './timeout-util.js';

/**
 * The dynamic matrix threw, timed out or returned an unsupported value; lets the
 * agent file it under the matrix_expansion init-failure category, not dynamic_eval.
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

export const MAX_DYNAMIC_JOBS = 100;

const DYNAMIC_FIELD_TIMEOUT_MS = 60_000;

/**
 * Context for resolving dynamic fields on generated jobs: the same context the
 * parent DynamicJobFn just received, threaded through rather than rebuilt.
 */
export interface SerializerContext {
  /** First argument to env/environment/concurrencyGroup fns. */
  event: Record<string, unknown>;
  $: typeof Shell;
  log: Logger;
  env: Record<string, string | undefined>;
  /** Surfaced as DynamicMatrixContext.ctx.workflow.name. */
  workflowName: string;
}

/**
 * @param seenNames - Names already emitted earlier in the eval round; a repeat
 *   throws, and every generated name is added for later generators
 * @throws Error on a duplicate name, an exceeded limit, or a dynamic function
 *   that throws, times out or returns an unsupported value
 */
export async function serializeJobsToLock(
  jobs: Job[],
  ctx: SerializerContext,
  staticNames?: Set<string>,
  allowedGroups?: Set<string>,
  seenNames?: Set<string>,
): Promise<LockJob[]> {
  if (jobs.length > MAX_DYNAMIC_JOBS) {
    throw new Error(
      `DynamicJobFn generated ${jobs.length} jobs, exceeding the limit of ${MAX_DYNAMIC_JOBS}`,
    );
  }

  // Unique within this output and, with a shared `seenNames`, across the round.
  const generatedNames = new Set<string>();
  const roundNames = seenNames ?? new Set<string>();
  for (const job of jobs) {
    if (roundNames.has(job.name)) {
      throw new Error(`Duplicate job name '${job.name}' in dynamic job output`);
    }
    generatedNames.add(job.name);
    roundNames.add(job.name);
  }

  // Sequential for deterministic ordering and error attribution.
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
  // An invoke gate dispatches to no agent, so it has no selector to normalize.
  const { include: runsOn, exclude: excludeLabels } =
    job.invoke && job.runsOn === undefined
      ? { include: [] as LabelMatcher[], exclude: [] as LabelMatcher[] }
      : normalizeRunsOnToMatchers(job.runsOn as never, `generated job '${job.name}' runsOn`);

  // `context` or `contexts` normalizes to an ordered list of static lock contexts.
  const envRefs = job.contexts ?? (job.context !== undefined ? [job.context] : undefined);
  let resolvedContexts: Array<{ value: string; dynamic: boolean }> | undefined;
  if (envRefs !== undefined && envRefs.length > 0) {
    const resolved: Array<{ value: string; dynamic: boolean }> = [];
    for (const ref of envRefs) {
      if (typeof ref === 'function') {
        const value = await withTimeout(
          () => (ref as (event: Record<string, unknown>) => string | Promise<string>)(ctx.event),
          DYNAMIC_FIELD_TIMEOUT_MS,
          `dynamic environment for generated job '${job.name}'`,
        );
        if (value !== undefined && value !== null) resolved.push({ value, dynamic: false });
      } else if (typeof ref === 'string') {
        resolved.push({ value: ref, dynamic: false });
      }
    }
    if (resolved.length > 0) resolvedContexts = resolved;
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

  const dependsOnGroups = resolvedNeeds
    .filter((n): n is NeedsGroupEntry => typeof n === 'object' && 'group' in n)
    .map((n) => n.group);

  const lockJob: LockJob = {
    _type: 'static',
    name: job.name,
    // A gate carries no runsOn; every other job always does.
    ...(job.invoke && runsOn.length === 0 ? {} : { runsOn }),
    ...(excludeLabels.length > 0 ? { excludeLabels } : {}),
    needs: resolvedNeeds,
    ...(dependsOnGroups.length > 0 ? { dependsOnGroups } : {}),
    steps: serializeSteps(job.steps),
    ...(resolvedMatrix ? { matrix: resolvedMatrix } : {}),
    ...(job.include ? { include: job.include } : {}),
    ...(job.exclude ? { exclude: job.exclude } : {}),
    ...(job.description ? { description: job.description } : {}),
    ...(resolvedContexts !== undefined ? { contexts: resolvedContexts } : {}),
    ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
    ...(resolvedConcurrencyGroup !== undefined
      ? { concurrencyGroup: resolvedConcurrencyGroup }
      : {}),
    // Carried over the eval-round wire so the orchestrator runs it as a gate, like a static one.
    ...(job.invoke
      ? {
          invoke: {
            event: job.invoke.event,
            scope: job.invoke.scope,
            ...(job.invoke.payload !== undefined ? { payload: job.invoke.payload } : {}),
            ...(job.invoke.optional === true ? { optional: true } : {}),
          },
        }
      : {}),
  };

  return lockJob;
}

/**
 * Resolve needs (name, Job, DynamicGroupRef, NeedsEntry / NeedsGroupEntry)
 * against generated + static names and allowedGroups. Emits strings for concrete
 * refs, NeedsEntry / NeedsGroupEntry otherwise, each `when` normalized to a runOn
 * status-set.
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
    if (typeof dep === 'string') {
      if (!allNames.has(dep)) {
        throw new Error(
          `Job dependency '${dep}' not found in workflow jobs ` +
            `(checked: ${generatedNames.size} generated, ${staticNames.size} static)`,
        );
      }
      return dep;
    }

    if (isDynamicGroupRef(dep)) {
      const groupRef = dep as DynamicGroupRef;
      if (!allowedGroups.has(groupRef.group)) {
        throw new Error(
          `Dynamic group '${groupRef.group}' not found in workflow ` +
            `(available groups: ${[...allowedGroups].join(', ') || 'none'})`,
        );
      }
      return {
        group: groupRef.group,
        runOn: resolveWhenToRunOn(groupRef.when),
      } as NeedsGroupEntry;
    }

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

    // Job object reference; a DynamicJobFn is rejected.
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

/** Steps carry only metadata; run functions load from the workflow bundle at execution time. */
function serializeSteps(steps: readonly StepInput[]): LockStepEntry[] {
  let flatIndex = 0;
  return steps.map((entry): LockStepEntry => {
    if (isParallelGroup(entry)) {
      const children = entry.steps.map((child) => serializeSequentialStep(child, flatIndex++));
      return {
        kind: 'parallel',
        name: entry.name ?? `parallel-${children[0]?.name ?? 'group'}`,
        failFast: entry.failFast,
        ...(entry.maxParallel !== undefined ? { maxParallel: entry.maxParallel } : {}),
        children,
      } satisfies LockParallelStep;
    }
    return serializeSequentialStep(entry, flatIndex++);
  });
}

function serializeSequentialStep(stepOrFn: StepInput, index: number): LockStep {
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
}

/**
 * Static matrices embed as-is; a dynamic matrix function runs against the eval
 * context (DynamicMatrixContext) and its result embeds.
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

  const matrixCtx: DynamicMatrixContext = {
    $: ctx.$,
    ctx: {
      workflow: { name: ctx.workflowName },
      job: {
        name: jobName,
        runsOn: runsOn.map(formatLabelMatcher),
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
