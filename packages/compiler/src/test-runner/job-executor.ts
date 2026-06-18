import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { logger } from '@kici-dev/core';
import type { Job, Step, Workflow, Rule } from '@kici-dev/sdk';
import {
  setStepOutputsMap as setStepOutputsMapLocal,
  setStepRefMap as setStepRefMapLocal,
  setJobOutputsMap as setJobOutputsMapLocal,
} from '@kici-dev/sdk';
import type { OutputsMap, StepRefMap } from '@kici-dev/sdk';
import { createStepContext } from './step-context.js';
import { createRuleContext, evaluateRules } from './rule-evaluator.js';
import { formatter } from './output-formatter.js';
import { localRunsOnString } from '../local-executor/runs-on-display.js';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { EventPayload, RuleResult } from '@kici-dev/sdk';
import type { ParsedSecrets } from './secrets-file.js';

/**
 * SDK output setters resolved from the workflow's module instance.
 * When the SDK is externalized in rolldown, the workflow shares the same
 * module instance. We use these to set up output infrastructure.
 */
interface SdkOutputSetters {
  setStepOutputsMap: (map: OutputsMap) => void;
  setStepRefMap: (map: StepRefMap) => void;
  setJobOutputsMap: (map: OutputsMap) => void;
}

/**
 * Resolve SDK output setter functions from the workflow's module instance.
 * This ensures the output maps are set on the same SDK module that the
 * workflow code uses for .result proxy resolution and ctx.outputsOf().
 *
 * Falls back to the compiler's own SDK import if dynamic resolution fails.
 */
async function resolveSdkSetters(kiciDir?: string): Promise<SdkOutputSetters> {
  if (kiciDir) {
    try {
      const sdkPath = path.join(kiciDir, 'node_modules', '@kici-dev', 'sdk', 'dist', 'index.js');
      const sdkUrl = pathToFileURL(sdkPath).href;
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

export interface StepResult {
  name: string;
  status: 'success' | 'failure';
  durationMs: number;
  error?: Error;
  outputs?: Record<string, unknown>;
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
}

/**
 * Execute a single step.
 */
async function executeStep(
  step: Step,
  ctx: ReturnType<typeof createStepContext>,
  jobName: string,
): Promise<StepResult> {
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

/**
 * Execute a job sequentially (steps run in order).
 */
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

  // Evaluate job rules first
  let ruleResults: RuleResult[] | undefined;
  if (job.rules && job.rules.length > 0) {
    const ruleContext = createRuleContext(event as EventPayload, event.changedFiles);
    const ruleEval = await evaluateRules(job.rules, ruleContext, job.name);
    ruleResults = ruleEval.results;

    if (!ruleEval.allPassed) {
      const durationMs = Date.now() - startTime;
      return {
        name: job.name,
        status: 'skipped',
        durationMs,
        steps: [],
        ruleResults,
      };
    }
  }

  // Set up output infrastructure for .result proxy and ctx.outputsOf() resolution
  // Set maps on both the workflow's SDK instance (for .result proxy) and the
  // compiler's SDK instance (for ctx.outputsOf/jobOutputs in step-context)
  const outputsMap: OutputsMap = new Map();
  const refMap: StepRefMap = new WeakMap();
  setters.setStepOutputsMap(outputsMap);
  setters.setStepRefMap(refMap);
  setStepOutputsMapLocal(outputsMap);
  setStepRefMapLocal(refMap);

  // Create step context
  const ctx = createStepContext(
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

  // Execute steps sequentially
  let stepCounter = 0;
  for (const stepOrFn of job.steps) {
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
      // Only increment counter for unnamed steps
      if (!normalizedStep.name) stepCounter++;
    }
    const result = await executeStep(normalizedStep, ctx, job.name);

    // Store successful step outputs in the map for .result proxy resolution
    if (result.status === 'success' && result.outputs != null) {
      outputsMap.set(normalizedStep.name, result.outputs);
    }
    stepResults.push(result);

    // Fail fast on step failure
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
}

/**
 * Execute a workflow with parallel job execution.
 * Jobs run in parallel where dependencies allow (respecting needs).
 */
export async function executeWorkflow(
  workflow: Workflow,
  event: SimulatedEvent,
  repoRoot: string,
  testSecrets?: ParsedSecrets,
  kiciDir?: string,
): Promise<WorkflowResult> {
  logger.info(`\n${pc.bold('▶ Running workflow:')} ${workflow.name}\n`);
  const startTime = Date.now();

  // Resolve SDK setters from the workflow's module instance
  const sdkSetters = await resolveSdkSetters(kiciDir);

  // Evaluate workflow rules first
  let ruleResults: RuleResult[] | undefined;
  if (workflow.rules && workflow.rules.length > 0) {
    const ruleContext = createRuleContext(event as EventPayload, event.changedFiles);
    const ruleEval = await evaluateRules(workflow.rules as Rule[], ruleContext, workflow.name);
    ruleResults = ruleEval.results;

    if (!ruleEval.allPassed) {
      const durationMs = Date.now() - startTime;
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

  // Build job dependency graph
  const staticJobs = workflow.jobs.filter((j): j is Job => typeof j !== 'function');
  const jobMap = new Map(staticJobs.map((j) => [j.name, j]));
  const completed = new Map<string, JobResult>();
  const pending = new Set(staticJobs.map((j) => j.name));

  // Cross-job output collection: maps job name -> aggregated step outputs
  // Used by ctx.jobOutputs() and jobRef.result for cross-job output chaining
  const jobOutputsMap: OutputsMap = new Map();
  sdkSetters.setJobOutputsMap(jobOutputsMap);
  setJobOutputsMapLocal(jobOutputsMap);

  // Execute jobs respecting dependencies
  while (pending.size > 0) {
    // Find jobs ready to run (all dependencies completed successfully)
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

    // Execute ready jobs in parallel
    const results = await Promise.allSettled(
      ready.map((jobName) => {
        const job = jobMap.get(jobName)!;
        pending.delete(jobName);
        return executeJob(job, workflow.name, event, repoRoot, testSecrets, sdkSetters);
      }),
    );

    // Record results and collect cross-job outputs
    for (let i = 0; i < ready.length; i++) {
      const result = results[i];
      const jobName = ready[i];

      if (result.status === 'fulfilled') {
        completed.set(jobName, result.value);

        // Collect job outputs for cross-job chaining
        if (result.value.status === 'success') {
          const jobResult = result.value;
          const stepsWithOutputs = jobResult.steps.filter((s) => s.outputs != null);

          if (stepsWithOutputs.length === 1 && jobResult.steps.length === 1) {
            // Single-step job (run shorthand): flatten outputs directly (no step-name nesting)
            jobOutputsMap.set(jobName, stepsWithOutputs[0].outputs!);
          } else if (stepsWithOutputs.length > 0) {
            // Multi-step job: nest outputs under step names
            const aggregated: Record<string, unknown> = {};
            for (const stepResult of stepsWithOutputs) {
              aggregated[stepResult.name] = stepResult.outputs;
            }
            jobOutputsMap.set(jobName, aggregated);
          }
        }

        // Fail fast on job failure
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
        // Promise rejected (unexpected)
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
