import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { Job, Step, Workflow, Rule, StepContext } from '@kici-dev/sdk';
import {
  setStepOutputsMap as setStepOutputsMapLocal,
  setStepRefMap as setStepRefMapLocal,
  setJobOutputsMap as setJobOutputsMapLocal,
} from '@kici-dev/sdk/internal';
import type { OutputsMap, StepRefMap } from '@kici-dev/sdk';
import type { CheckStepOutcome } from '@kici-dev/engine';
import { createStepContext } from './step-context.js';
import { createRuleContext, evaluateRules } from './rule-evaluator.js';
import { formatter } from './output-formatter.js';
import { localRunsOnString } from './runs-on-display.js';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { EventPayload, RuleResult } from '@kici-dev/sdk';
import type { ParsedSecrets } from './secrets-file.js';

/** SDK output setters from the workflow's module instance (shared when rolldown externalizes the SDK). */
interface SdkOutputSetters {
  setStepOutputsMap: (map: OutputsMap) => void;
  setStepRefMap: (map: StepRefMap) => void;
  setJobOutputsMap: (map: OutputsMap) => void;
}

/**
 * Resolve the setters from the workflow's own SDK module (the
 * `@kici-dev/sdk/internal` subpath), so the maps land where its .result proxy
 * and ctx.outputsOf() read them. Falls back to the compiler's own SDK import.
 */
async function resolveSdkSetters(kiciDir?: string): Promise<SdkOutputSetters> {
  if (kiciDir) {
    try {
      const sdkPath = path.join(kiciDir, 'node_modules', '@kici-dev', 'sdk', 'dist', 'internal.js');
      const sdkUrl = pathToFileURL(sdkPath).href;
      const sdk = await import(sdkUrl);
      return {
        setStepOutputsMap: sdk.setStepOutputsMap,
        setStepRefMap: sdk.setStepRefMap,
        setJobOutputsMap: sdk.setJobOutputsMap,
      };
    } catch {
      // Fall back to the compiler's SDK import.
    }
  }
  return {
    setStepOutputsMap: setStepOutputsMapLocal,
    setStepRefMap: setStepRefMapLocal,
    setJobOutputsMap: setJobOutputsMapLocal,
  };
}

export interface StepResult {
  name: string;
  status: 'success' | 'failure' | 'skipped';
  durationMs: number;
  error?: Error;
  outputs?: Record<string, unknown>;
  /** Idempotent per-step outcome under a non-default check mode. */
  checkOutcome?: CheckStepOutcome;
  /** Human-readable drift summary, present when drift was detected. */
  driftSummary?: string;
}

export interface JobResult {
  name: string;
  status: 'success' | 'failure' | 'skipped';
  durationMs: number;
  steps: StepResult[];
  ruleResults?: RuleResult[];
  error?: Error;
}

interface WorkflowResult {
  name: string;
  status: 'success' | 'failure' | 'skipped';
  durationMs: number;
  jobs: JobResult[];
  ruleResults?: RuleResult[];
  error?: Error;
}

async function executeStep(step: Step, ctx: StepContext, jobName: string): Promise<StepResult> {
  formatter.logStepStart(jobName, step.name);
  const startTime = Date.now();

  try {
    const outputs = await step.run(ctx);
    const durationMs = Date.now() - startTime;
    formatter.logStepComplete(jobName, step.name, durationMs);

    return {
      name: step.name,
      status: 'success',
      durationMs,
      outputs: outputs as Record<string, unknown> | undefined,
    };
  } catch (e) {
    const durationMs = Date.now() - startTime;
    const error = e instanceof Error ? e : new Error(String(e));
    formatter.logStepError(jobName, step.name, error);

    return {
      name: step.name,
      status: 'failure',
      durationMs,
      error,
    };
  }
}

/** Steps run in order. */
export async function executeJob(
  job: Job,
  workflowName: string,
  event: SimulatedEvent,
  repoRoot: string,
  testSecrets?: ParsedSecrets,
  sdkSetters?: SdkOutputSetters,
): Promise<JobResult> {
  const setters = sdkSetters ?? {
    setStepOutputsMap: setStepOutputsMapLocal,
    setStepRefMap: setStepRefMapLocal,
    setJobOutputsMap: setJobOutputsMapLocal,
  };
  formatter.logJobStart(job.name);
  const startTime = Date.now();
  const stepResults: StepResult[] = [];

  let ruleResults: RuleResult[] | undefined;
  if (job.rules && job.rules.length > 0) {
    const ruleContext = createRuleContext({
      event: event as EventPayload,
      changedFiles: event.changedFiles,
      changedFilesStatus: event.changedFilesStatus ?? 'fetched',
    });
    const ruleEval = await evaluateRules(job.rules, ruleContext, job.name);
    ruleResults = ruleEval.results;

    if (!ruleEval.allPassed) {
      const durationMs = Date.now() - startTime;
      // A throwing check() fails the job so the crash surfaces; a clean false skips.
      if (ruleEval.evaluationError) {
        return {
          name: job.name,
          status: 'failure',
          durationMs,
          steps: [],
          ruleResults,
          error: new Error(
            `rule '${ruleEval.evaluationError.label}' errored: ${ruleEval.evaluationError.message}`,
          ),
        };
      }
      return {
        name: job.name,
        status: 'skipped',
        durationMs,
        steps: [],
        ruleResults,
      };
    }
  }

  // Set the maps on the workflow's SDK (for the .result proxy) and the
  // compiler's SDK (for ctx.outputsOf/jobOutputs in step-context).
  const outputsMap: OutputsMap = new Map();
  const refMap: StepRefMap = new WeakMap();
  setters.setStepOutputsMap(outputsMap);
  setters.setStepRefMap(refMap);
  setStepOutputsMapLocal(outputsMap);
  setStepRefMapLocal(refMap);

  // `dispose` drains the job-scoped `ctx.mktemp`/`ctx.mktempFile` allocator and
  // secrets state. This path runs no job-end hooks, so the `finally` below calls it.
  const { ctx, dispose } = createStepContext(
    { name: workflowName },
    {
      name: job.name,
      runsOn: localRunsOnString(job.runsOn),
    },
    repoRoot,
    undefined,
    undefined,
    testSecrets,
    undefined,
    event.payload,
    event.provider,
  );

  try {
    let stepCounter = 0;
    for (const stepOrFn of job.steps) {
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
        // Name the ORIGINAL object, not a clone, so the SDK's late-bound .result
        // proxy resolves and each id-less step gets a distinct step-N key. Each
        // step object is visited once, so in-place mutation is safe.
        if (!normalizedStep.name) {
          stepCounter++;
          (normalizedStep as { name: string }).name = `step-${stepCounter}`;
        }
      }
      const result = await executeStep(normalizedStep, ctx, job.name);

      if (result.status === 'success' && result.outputs != null) {
        outputsMap.set(normalizedStep.name, result.outputs);
      }
      stepResults.push(result);

      if (result.status === 'failure') {
        const durationMs = Date.now() - startTime;
        formatter.logJobFailure(job.name, durationMs, result.error!);

        return {
          name: job.name,
          status: 'failure',
          durationMs,
          steps: stepResults,
          ruleResults,
          error: result.error,
        };
      }
    }

    const durationMs = Date.now() - startTime;
    formatter.logJobComplete(job.name, durationMs);

    return {
      name: job.name,
      status: 'success',
      durationMs,
      steps: stepResults,
      ruleResults,
    };
  } finally {
    // Runs on success, failure and throw. A cleanup failure must NEVER change
    // the job's terminal status, so a drain error becomes a warn.
    await dispose().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`local job temp scope cleanup failed: ${message}`);
    });
  }
}

/** Jobs run in parallel where their `needs` allow. */
export async function executeWorkflow(
  workflow: Workflow,
  event: SimulatedEvent,
  repoRoot: string,
  testSecrets?: ParsedSecrets,
  kiciDir?: string,
): Promise<WorkflowResult> {
  logger.info(`\n${pc.bold('▶ Running workflow:')} ${workflow.name}\n`);
  const startTime = Date.now();

  const sdkSetters = await resolveSdkSetters(kiciDir);

  let ruleResults: RuleResult[] | undefined;
  if (workflow.rules && workflow.rules.length > 0) {
    const ruleContext = createRuleContext({
      event: event as EventPayload,
      changedFiles: event.changedFiles,
      changedFilesStatus: event.changedFilesStatus ?? 'fetched',
    });
    const ruleEval = await evaluateRules(workflow.rules as Rule[], ruleContext, workflow.name);
    ruleResults = ruleEval.results;

    if (!ruleEval.allPassed) {
      const durationMs = Date.now() - startTime;
      // A throwing check() fails the workflow (non-zero exit); a clean false skips.
      if (ruleEval.evaluationError) {
        const error = new Error(
          `rule '${ruleEval.evaluationError.label}' errored: ${ruleEval.evaluationError.message}`,
        );
        logger.info(pc.red(`\n✗ Workflow failed: ${error.message}\n`));
        return {
          name: workflow.name,
          status: 'failure',
          durationMs,
          jobs: [],
          ruleResults,
          error,
        };
      }
      logger.info(pc.yellow(`\n⚠ Workflow skipped due to rule failure\n`));
      return {
        name: workflow.name,
        status: 'skipped',
        durationMs,
        jobs: [],
        ruleResults,
      };
    }
  }

  const staticJobs = workflow.jobs.filter((j): j is Job => typeof j !== 'function');
  const jobMap = new Map(staticJobs.map((j) => [j.name, j]));
  const completed = new Map<string, JobResult>();
  const pending = new Set(staticJobs.map((j) => j.name));

  // Job name → aggregated step outputs, read by ctx.jobOutputs() and jobRef.result.
  const jobOutputsMap: OutputsMap = new Map();
  sdkSetters.setJobOutputsMap(jobOutputsMap);
  setJobOutputsMapLocal(jobOutputsMap);

  while (pending.size > 0) {
    const ready = [...pending].filter((jobName) => {
      const job = jobMap.get(jobName)!;
      if (!job.needs || job.needs.length === 0) return true;

      return job.needs.every((need) => {
        let needName: string;
        if (typeof need === 'string') {
          needName = need;
        } else if ('name' in need) {
          needName = (need as { name: string }).name;
        } else if ('group' in need) {
          // Dynamic group refs can't be resolved in local test runner
          return true;
        } else {
          needName = (need as { name: string }).name;
        }
        const result = completed.get(needName);
        return result && result.status === 'success';
      });
    });

    if (ready.length === 0 && pending.size > 0) {
      // Deadlock or dependencies failed
      const remaining = [...pending];
      logger.info(
        pc.yellow(`\n⚠ Skipping jobs with failed dependencies: ${remaining.join(', ')}\n`),
      );
      break;
    }

    const results = await Promise.allSettled(
      ready.map((jobName) => {
        const job = jobMap.get(jobName)!;
        pending.delete(jobName);
        return executeJob(job, workflow.name, event, repoRoot, testSecrets, sdkSetters);
      }),
    );

    for (let i = 0; i < ready.length; i++) {
      const result = results[i];
      const jobName = ready[i];

      if (result.status === 'fulfilled') {
        completed.set(jobName, result.value);

        if (result.value.status === 'success') {
          const jobResult = result.value;
          const stepsWithOutputs = jobResult.steps.filter((s) => s.outputs != null);

          if (stepsWithOutputs.length === 1 && jobResult.steps.length === 1) {
            // A single-step (run shorthand) job's outputs are not nested under a step name.
            jobOutputsMap.set(jobName, stepsWithOutputs[0].outputs!);
          } else if (stepsWithOutputs.length > 0) {
            const aggregated: Record<string, unknown> = {};
            for (const stepResult of stepsWithOutputs) {
              aggregated[stepResult.name] = stepResult.outputs;
            }
            jobOutputsMap.set(jobName, aggregated);
          }
        }

        if (result.value.status === 'failure') {
          const durationMs = Date.now() - startTime;
          logger.info(pc.red(`\n✗ Workflow failed\n`));
          return {
            name: workflow.name,
            status: 'failure',
            durationMs,
            jobs: [...completed.values()],
            ruleResults,
          };
        }
      } else {
        completed.set(jobName, {
          name: jobName,
          status: 'failure',
          durationMs: 0,
          steps: [],
          error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        });
      }
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info(pc.green(`\n✓ Workflow complete`) + pc.gray(` (${durationMs}ms)\n`));

  return {
    name: workflow.name,
    status: 'success',
    durationMs,
    jobs: [...completed.values()],
    ruleResults,
  };
}
