/**
 * Job resolution (matrix/dynamic) and single-job execution with step context.
 *
 * Handles:
 * - Static job resolution
 * - Matrix expansion into multiple ResolvedJob instances
 * - Dynamic job function evaluation
 * - Single-job step-by-step execution with rules, abort, and output chaining
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Job, Step, Workflow, Rule, OutputsMap, StepRefMap } from '@kici-dev/sdk';
import {
  expandMatrix,
  applyIncludeExclude,
  isDynamicJobFn,
  setStepOutputsMap as setStepOutputsMapLocal,
  setStepRefMap as setStepRefMapLocal,
  setJobOutputsMap as setJobOutputsMapLocal,
} from '@kici-dev/sdk';
import { formatMatrixSuffix } from '@kici-dev/engine';
import type { SimulatedEvent, MatrixValues } from '@kici-dev/engine';
import type { EventPayload } from '@kici-dev/sdk';
import { ensureTsLoaderHook } from '../execution/ts-loader.js';
import { toEventPayload } from './to-event-payload.js';
import { createStepContext } from '../test-runner/step-context.js';
import { createRuleContext, evaluateRules } from '../test-runner/rule-evaluator.js';
import { formatter } from '../test-runner/output-formatter.js';
import type { ParsedSecrets } from '../test-runner/secrets-file.js';
import type { ResolvedJob, LocalJobResult } from './types.js';
import type { StepResult } from '../test-runner/job-executor.js';
import type { RuleResult } from '@kici-dev/sdk';
import { localRunsOnString } from './runs-on-display.js';

/**
 * Context passed to executeResolvedJob for single-job execution.
 */
export interface JobExecutionContext {
  workflowName: string;
  event: SimulatedEvent;
  secrets: ParsedSecrets;
  /** Original `.kici/` dir — used for compile, secrets, and SDK setter resolution. */
  kiciDir: string;
  /** Directory steps execute against (isolated tmp checkout, or the repo root with --in-place). */
  execDir: string;
  jobOutputsMap: OutputsMap;
  signal: AbortSignal;
}

/**
 * SDK output setters resolved from the workflow's module instance.
 */
interface SdkOutputSetters {
  setStepOutputsMap: (map: OutputsMap) => void;
  setStepRefMap: (map: StepRefMap) => void;
  setJobOutputsMap: (map: OutputsMap) => void;
}

/**
 * Resolve SDK output setter functions from the workflow's module instance.
 * Ensures output maps are set on the same SDK module the workflow code uses.
 */
async function resolveSdkSetters(kiciDir?: string): Promise<SdkOutputSetters> {
  if (kiciDir) {
    try {
      const sdkPath = path.join(kiciDir, 'node_modules', '@kici-dev', 'sdk', 'dist', 'index.js');
      const sdkUrl = pathToFileURL(sdkPath).href;
      ensureTsLoaderHook();
      const sdk = await import(sdkUrl);
      return {
        setStepOutputsMap: sdk.setStepOutputsMap,
        setStepRefMap: sdk.setStepRefMap,
        setJobOutputsMap: sdk.setJobOutputsMap,
      };
    } catch {
      // Fall back to compiler's SDK import
    }
  }
  return {
    setStepOutputsMap: setStepOutputsMapLocal,
    setStepRefMap: setStepRefMapLocal,
    setJobOutputsMap: setJobOutputsMapLocal,
  };
}

/**
 * Resolve a needs entry to a string name.
 * Handles Job objects, strings, DynamicGroupRef, and object forms.
 */
function resolveNeedName(need: NonNullable<Job['needs']>[number]): string {
  if (typeof need === 'string') return need;
  if ('name' in need) return (need as { name: string }).name;
  if ('group' in need) return `__group:${(need as { group: string }).group}`;
  return (need as Job).name;
}

/** A matrix outputs envelope as exposed to a downstream `needs:` consumer. */
interface MatrixOutputsEnvelope {
  byMatrix: Record<string, Record<string, unknown>>;
  merged: Record<string, unknown>;
}

/**
 * Maintain the base-name `{ byMatrix, merged }` envelope as each matrix child
 * completes. `merged` is rebuilt last-write-wins in suffix order so the result
 * is deterministic regardless of child completion order — matching the remote
 * path's name-ordered merge.
 */
function updateBaseMatrixEnvelope(
  jobOutputsMap: Map<string, Record<string, unknown>>,
  baseName: string,
  matrixValues: MatrixValues,
  childOutputs: Record<string, unknown>,
): void {
  const existing = jobOutputsMap.get(baseName) as MatrixOutputsEnvelope | undefined;
  const byMatrix: Record<string, Record<string, unknown>> = existing && 'byMatrix' in existing
    ? { ...existing.byMatrix }
    : {};
  const suffix = formatMatrixSuffix(matrixValues);
  byMatrix[suffix] = childOutputs;
  let merged: Record<string, unknown> = {};
  for (const key of Object.keys(byMatrix).sort()) {
    merged = { ...merged, ...byMatrix[key] };
  }
  jobOutputsMap.set(baseName, { byMatrix, merged });
}

/**
 * Resolve all jobs in a workflow, expanding matrix jobs and evaluating dynamic jobs.
 *
 * - Static jobs: create ResolvedJob with name, needs, job reference
 * - Matrix jobs: use expandMatrix() from SDK, create one ResolvedJob per combination
 * - Dynamic job functions: evaluate the function, recursively resolve results
 * - Fan-in: if a job needs a matrix-expanded job, it needs ALL instances
 */
export async function resolveJobs(
  workflow: Workflow,
  event: SimulatedEvent,
): Promise<ResolvedJob[]> {
  const resolved: ResolvedJob[] = [];
  // Track which base job names expanded into matrix instances
  const expansionMap = new Map<string, string[]>();

  for (const jobOrFn of workflow.jobs) {
    if (isDynamicJobFn(jobOrFn)) {
      // Evaluate dynamic job function
      const dynamicContext = {
        $: (await import('zx')).$ as any,
        ctx: {
          workflow: { name: workflow.name },
          // Normalized event envelope: top-level normalized fields (type,
          // targetBranch, …) plus the raw provider body under `payload`.
          event: toEventPayload(event),
        },
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        env: { ...process.env } as Record<string, string | undefined>,
        kici: {
          infrastructure: {
            list: () => Promise.resolve({ scalers: [], agents: [] }),
          },
          oidc: {
            // OIDC ID tokens require the orchestrator->Platform mint relay,
            // which is not available during local execution.
            token: () =>
              Promise.reject(
                new Error('ctx.kici.oidc.token() is not available during local execution'),
              ),
          },
        },
      };
      const generatedJobs = await jobOrFn(dynamicContext);
      // Recursively resolve generated jobs (they could also have matrices)
      for (const genJob of generatedJobs) {
        const genResolved = await resolveStaticJob(genJob, expansionMap);
        resolved.push(...genResolved);
      }
    } else {
      const jobResolved = await resolveStaticJob(jobOrFn as Job, expansionMap);
      resolved.push(...jobResolved);
    }
  }

  // Second pass: resolve needs references, expanding to matrix instances (fan-in)
  for (const r of resolved) {
    r.resolvedNeeds = resolveNeedsWithExpansion(r.job, expansionMap);
  }

  return resolved;
}

/**
 * Resolve a single static job, potentially expanding its matrix.
 */
async function resolveStaticJob(
  job: Job,
  expansionMap: Map<string, string[]>,
): Promise<ResolvedJob[]> {
  if (!job.matrix) {
    // No matrix -- single job
    expansionMap.set(job.name, [job.name]);
    return [
      {
        job,
        expandedName: job.name,
        matrixValues: {},
        resolvedNeeds: [], // Will be filled in second pass
      },
    ];
  }

  // Expand matrix
  let staticMatrix: any;
  if (typeof job.matrix === 'function') {
    // Dynamic matrix function -- evaluate it
    const matrixContext = {
      $: (await import('zx')).$ as any,
      ctx: {
        workflow: { name: '' },
        job: { name: job.name, runsOn: localRunsOnString(job.runsOn) },
      },
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      env: { ...process.env } as Record<string, string | undefined>,
    };
    staticMatrix = await job.matrix(matrixContext);
  } else {
    staticMatrix = job.matrix;
  }

  let expanded = expandMatrix(staticMatrix);

  // Apply include/exclude
  if (job.include || job.exclude) {
    expanded = applyIncludeExclude(expanded, job.include, job.exclude);
  }

  const expandedNames: string[] = [];
  const results: ResolvedJob[] = [];

  for (const matrixValues of expanded) {
    const suffix = formatMatrixSuffix(matrixValues);
    const expandedName = `${job.name} (${suffix})`;
    expandedNames.push(expandedName);

    results.push({
      job,
      expandedName,
      matrixValues,
      resolvedNeeds: [], // Will be filled in second pass
    });
  }

  expansionMap.set(job.name, expandedNames);
  return results;
}

/**
 * Resolve needs with matrix expansion awareness.
 * If a job needs a matrix-expanded job, it needs ALL expanded instances (fan-in).
 */
function resolveNeedsWithExpansion(job: Job, expansionMap: Map<string, string[]>): string[] {
  if (!job.needs || job.needs.length === 0) return [];

  const resolvedNeeds: string[] = [];
  for (const need of job.needs) {
    const needName = resolveNeedName(need);
    const expandedNames = expansionMap.get(needName);
    if (expandedNames) {
      resolvedNeeds.push(...expandedNames);
    } else {
      resolvedNeeds.push(needName);
    }
  }
  return resolvedNeeds;
}

/**
 * Execute a single resolved job: evaluate rules, run steps sequentially,
 * check abort signal between steps, collect outputs.
 */
export async function executeResolvedJob(
  resolvedJob: ResolvedJob,
  context: JobExecutionContext,
): Promise<LocalJobResult> {
  const { expandedName, matrixValues } = resolvedJob;
  const startTime = Date.now();
  const hasMatrix = Object.keys(matrixValues).length > 0;

  try {
    return await executeResolvedJobInner(resolvedJob, context, startTime);
  } catch (e) {
    const durationMs = Date.now() - startTime;
    const error = e instanceof Error ? e : new Error(String(e));
    formatter.logJobFailure(expandedName, durationMs, error);
    return {
      name: expandedName,
      status: 'failure',
      durationMs,
      steps: [],
      error,
      matrixValues: hasMatrix ? matrixValues : undefined,
    };
  }
}

async function executeResolvedJobInner(
  resolvedJob: ResolvedJob,
  context: JobExecutionContext,
  startTime: number,
): Promise<LocalJobResult> {
  const { job, expandedName, matrixValues } = resolvedJob;

  formatter.logJobStart(expandedName);

  // Resolve SDK setters for output infrastructure
  const sdkSetters = await resolveSdkSetters(context.kiciDir);

  // Evaluate job rules first
  let ruleResults: RuleResult[] | undefined;
  if (job.rules && job.rules.length > 0) {
    const ruleContext = createRuleContext(
      context.event as EventPayload,
      context.event.changedFiles,
    );
    const ruleEval = await evaluateRules(job.rules as Rule[], ruleContext, expandedName);
    ruleResults = ruleEval.results;

    if (!ruleEval.allPassed) {
      const durationMs = Date.now() - startTime;
      return {
        name: expandedName,
        status: 'skipped',
        durationMs,
        steps: [],
        ruleResults,
        matrixValues: Object.keys(matrixValues).length > 0 ? matrixValues : undefined,
      };
    }
  }

  // Set up output infrastructure
  const outputsMap: OutputsMap = new Map();
  const refMap: StepRefMap = new WeakMap();
  sdkSetters.setStepOutputsMap(outputsMap);
  sdkSetters.setStepRefMap(refMap);
  setStepOutputsMapLocal(outputsMap);
  setStepRefMapLocal(refMap);

  // Set job outputs map on both instances
  sdkSetters.setJobOutputsMap(context.jobOutputsMap);
  setJobOutputsMapLocal(context.jobOutputsMap);

  // Create step context with matrix values and secrets
  const hasMatrix = Object.keys(matrixValues).length > 0;
  // Steps run against the execution dir (an isolated tmp checkout by default,
  // or the repo root with --in-place). Pinning ctx.$ here matches the agent
  // path's `cwd: workDir`.
  const repoRoot = context.execDir;
  const stepCtx = createStepContext(
    { name: context.workflowName },
    {
      name: expandedName,
      runsOn: localRunsOnString(job.runsOn),
    },
    repoRoot,
    undefined,
    hasMatrix ? matrixValues : undefined,
    context.secrets,
    undefined,
    context.event.payload,
    context.event.provider,
  );

  // Execute steps sequentially
  const stepResults: StepResult[] = [];
  let stepCounter = 0;

  for (const stepOrFn of job.steps) {
    // Check abort signal between steps
    if (context.signal.aborted) {
      const durationMs = Date.now() - startTime;
      return {
        name: expandedName,
        status: 'cancelled',
        durationMs,
        steps: stepResults,
        ruleResults,
        matrixValues: hasMatrix ? matrixValues : undefined,
        cancelled: true,
      };
    }

    // Normalize bare functions to Step-like objects
    let normalizedStep: Step;
    if (typeof stepOrFn === 'function') {
      stepCounter++;
      const name = `step-${stepCounter}`;
      refMap.set(stepOrFn, name);
      normalizedStep = {
        _tag: 'Step' as const,
        name,
        run: stepOrFn,
      } as Step;
    } else {
      normalizedStep = stepOrFn as Step;
      if (!normalizedStep.name) stepCounter++;
    }

    // Execute step
    formatter.logStepStart(expandedName, normalizedStep.name);
    const stepStart = Date.now();

    try {
      const outputs = await normalizedStep.run(stepCtx);
      const stepDuration = Date.now() - stepStart;
      formatter.logStepComplete(expandedName, normalizedStep.name, stepDuration);

      const stepResult: StepResult = {
        name: normalizedStep.name,
        status: 'success',
        durationMs: stepDuration,
        outputs: outputs as Record<string, unknown> | undefined,
      };

      // Store outputs in map for .result proxy resolution
      if (outputs != null) {
        outputsMap.set(normalizedStep.name, outputs as Record<string, unknown>);
      }
      stepResults.push(stepResult);
    } catch (e) {
      const stepDuration = Date.now() - stepStart;
      const error = e instanceof Error ? e : new Error(String(e));
      formatter.logStepError(expandedName, normalizedStep.name, error);

      stepResults.push({
        name: normalizedStep.name,
        status: 'failure',
        durationMs: stepDuration,
        error,
      });

      // Fail fast on step failure
      const durationMs = Date.now() - startTime;
      formatter.logJobFailure(expandedName, durationMs, error);

      return {
        name: expandedName,
        status: 'failure',
        durationMs,
        steps: stepResults,
        ruleResults,
        matrixValues: hasMatrix ? matrixValues : undefined,
        error,
      };
    }
  }

  // Collect job outputs for cross-job chaining
  const stepsWithOutputs = stepResults.filter((s) => s.outputs != null);
  let jobOutputs: Record<string, unknown> | undefined;
  if (stepsWithOutputs.length === 1 && stepResults.length === 1) {
    // Single-step job: flatten outputs directly
    jobOutputs = stepsWithOutputs[0].outputs!;
  } else if (stepsWithOutputs.length > 0) {
    // Multi-step job: nest outputs under step names
    const aggregated: Record<string, unknown> = {};
    for (const stepResult of stepsWithOutputs) {
      aggregated[stepResult.name] = stepResult.outputs;
    }
    jobOutputs = aggregated;
  }
  if (jobOutputs) {
    context.jobOutputsMap.set(expandedName, jobOutputs);
    // Matrix parity with the remote path: a downstream that needs a matrix job
    // reads `{ byMatrix, merged }` under the BASE name. Rebuild that envelope as
    // each child completes so it is available to downstream jobs at dispatch.
    if (expandedName !== job.name) {
      updateBaseMatrixEnvelope(context.jobOutputsMap, job.name, matrixValues, jobOutputs);
    }
  }

  const durationMs = Date.now() - startTime;
  formatter.logJobComplete(expandedName, durationMs);

  return {
    name: expandedName,
    status: 'success',
    durationMs,
    steps: stepResults,
    ruleResults,
    matrixValues: hasMatrix ? matrixValues : undefined,
  };
}
