/**
 * Public API: executeLocal() orchestrating compile, match, resolve, schedule, report.
 *
 * Pipeline:
 * 1. Compile workflows from .kici/ sources
 * 2. Load workflows (discover runtime modules)
 * 3. Load secrets from local files
 * 4. Build event payload from git state + CLI overrides
 * 5. Match triggers to find active workflows
 * 6. Apply --workflow and --job filters
 * 7. Resolve jobs (matrix expansion, dynamic evaluation)
 * 8. Execute via DAG scheduler with concurrency control
 * 9. Return success/failure
 */

import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { logger } from '@kici-dev/core';
import pc from 'picocolors';
import { matchAllWorkflows } from '@kici-dev/engine';
import type { SimulatedEvent } from '@kici-dev/engine';
import type { Workflow } from '@kici-dev/sdk';
import { compileCommand } from '../commands/compile.js';
import { discoverWorkflows, resolveKiciDir } from '../execution/index.js';
import { transformTriggers } from '../lockfile/generator.js';
import { loadLocalSecrets } from './secret-loader.js';
import { generateEventPayload } from './payload-generator.js';
import { resolveJobs, executeResolvedJob } from './job-runner.js';
import { executeDag, resolveJobFilter } from './dag-scheduler.js';
import {
  displayLocalSummary,
  formatLocalJsonResult,
  formatLocalJunitResult,
} from './output-streamer.js';
import { runPicker, PickerCancelledError } from './picker.js';
import { materializeCheckout, gcStaleRunCheckouts } from './materializer.js';
import type { MaterializedCheckout } from './materializer.js';
import { acquireWorkflowLock, ConcurrencyKeyEvaluationError } from './workflow-lock.js';
import type { WorkflowLockHandle } from './workflow-lock.js';
import type { ParsedSecrets } from '../test-runner/secrets-file.js';
import type { RunLocalOptions, WorkflowExecutionResult, LocalJobResult } from './types.js';
import type { DagNode } from './dag-scheduler.js';

/**
 * Convert SDK workflows to lock-file-like structure for trigger matching.
 * Simplified version of the one in test.ts -- only needs trigger info.
 */
function workflowsToLockFormat(workflows: Workflow[]) {
  return workflows.map((w) => ({
    name: w.name,
    contentHash: '',
    compileSchemaVersion: 0,
    triggers: transformTriggers(w.on),
    jobs: w.jobs.map((j, i) => {
      if (typeof j === 'function') {
        return { _type: 'dynamic' as const, source: { file: '', index: i } };
      }
      return {
        _type: 'static' as const,
        name: j.name,
        runsOn: j.runsOn,
        needs: j.needs?.map((n: any) => (typeof n === 'string' ? n : n.name)) ?? [],
        steps: j.steps.map((s: any) => {
          if (typeof s === 'function') return { name: '', hasOutputs: false };
          return { name: s.name, hasOutputs: !!s.outputs };
        }),
      };
    }),
    rules: w.rules?.map((r: any, i: number) => ({
      _type: 'dynamic' as const,
      label: r.label,
      source: { file: '', index: i },
    })),
  }));
}

/**
 * Derive `groupCtx.branch` for the workflow concurrency `group` callback.
 * Mirrors the agent's semantics (`request.branch ?? request.ref`) so a
 * `group({ branch })` function works identically locally and remotely.
 */
function deriveBranchForGroupCtx(event: SimulatedEvent): string {
  if (event.targetBranch) return event.targetBranch;
  if (event.sourceBranch) return event.sourceBranch;
  const ref = event.payload?.ref;
  if (typeof ref === 'string') {
    const m = /^refs\/heads\/(.+)$/.exec(ref);
    if (m) return m[1];
  }
  return '';
}

/**
 * Context for {@link runOneMatchedWorkflow}.
 */
interface RunOneMatchedWorkflowContext {
  options: RunLocalOptions;
  isQuiet: boolean;
  event: SimulatedEvent;
  secrets: ParsedSecrets;
  kiciDir: string;
  /** Directory steps execute against (isolated tmp checkout, or repo root with --in-place). */
  execDir: string;
  concurrency: number;
  failFast: boolean;
}

/**
 * Execute one matched workflow under its concurrency lock (if any).
 *
 * Returns the result and a flag indicating whether it should count towards
 * `allSucceeded`. Returns `null` when the workflow was filtered out (e.g. by
 * `--job` removing every node).
 */
async function runOneMatchedWorkflow(
  workflow: Workflow,
  ctx: RunOneMatchedWorkflowContext,
): Promise<{ result: WorkflowExecutionResult; succeeded: boolean } | null> {
  const { options, isQuiet, event, secrets, kiciDir, concurrency, failFast } = ctx;
  if (!isQuiet) {
    logger.info(`\n${pc.bold('Running workflow:')} ${workflow.name}\n`);
  }

  // Acquire the workflow-level concurrency lock (no-op if no concurrency block).
  let lockHandle: WorkflowLockHandle | null = null;
  try {
    lockHandle = await acquireWorkflowLock({
      workflowName: workflow.name,
      workflow,
      event,
      branch: deriveBranchForGroupCtx(event),
      debug: options.debug,
    });
  } catch (err) {
    if (err instanceof ConcurrencyKeyEvaluationError) {
      logger.error(
        pc.red(
          `Concurrency group evaluation failed for workflow "${workflow.name}": ${err.cause?.message ?? err.message}`,
        ),
      );
      return {
        result: { name: workflow.name, status: 'failure', jobs: [], durationMs: 0 },
        succeeded: false,
      };
    }
    throw err;
  }

  try {
    return await runWorkflowBody(workflow, ctx, options, secrets, kiciDir, concurrency, failFast);
  } finally {
    await lockHandle?.release();
  }
}

/**
 * The actual DAG-execution body for one workflow. Split out so
 * {@link runOneMatchedWorkflow} can wrap it in a lock acquire/release.
 */
async function runWorkflowBody(
  workflow: Workflow,
  ctx: RunOneMatchedWorkflowContext,
  options: RunLocalOptions,
  secrets: ParsedSecrets,
  kiciDir: string,
  concurrency: number,
  failFast: boolean,
): Promise<{ result: WorkflowExecutionResult; succeeded: boolean } | null> {
  const { event } = ctx;

  // Resolve jobs (matrix expansion, dynamic evaluation)
  const resolvedJobs = await resolveJobs(workflow, event);

  // Convert to DagNode format
  let dagNodes: DagNode[] = resolvedJobs.map((r) => ({
    name: r.expandedName,
    needs: r.resolvedNeeds,
  }));

  // Apply --job filter
  if (options.job) {
    dagNodes = resolveJobFilter(dagNodes, options.job);
    if (dagNodes.length === 0) {
      // Job not found in this workflow — skip it
      return null;
    }
  }

  // Build a lookup for resolved jobs by expanded name
  const resolvedJobMap = new Map(resolvedJobs.map((r) => [r.expandedName, r]));

  // Filter resolved jobs to only include those in the DAG
  const dagNodeNames = new Set(dagNodes.map((n) => n.name));
  const filteredResolvedJobs = resolvedJobs.filter((r) => dagNodeNames.has(r.expandedName));

  // Cross-job output collection
  const jobOutputsMap = new Map<string, Record<string, unknown>>();

  const startTime = Date.now();

  // Execute via DAG scheduler
  const dagResult = await executeDag(
    dagNodes,
    {
      execute: async (name: string, signal: AbortSignal) => {
        const resolved = resolvedJobMap.get(name);
        if (!resolved) {
          return {
            name,
            status: 'failure' as const,
            durationMs: 0,
            steps: [],
            error: new Error(`Job "${name}" not found in resolved jobs`),
          };
        }

        return executeResolvedJob(resolved, {
          workflowName: workflow.name,
          event,
          secrets,
          kiciDir,
          execDir: ctx.execDir,
          jobOutputsMap,
          signal,
        });
      },
      isSuccess: (result) => result.status === 'success' || result.status === 'skipped',
    },
    {
      maxConcurrency: concurrency,
      failFast,
    },
  );

  const durationMs = Date.now() - startTime;

  // Collect job results with matrix values and skipped/cancelled status
  const jobResults: LocalJobResult[] = [];
  for (const rj of filteredResolvedJobs) {
    const result = dagResult.results.get(rj.expandedName);
    if (result) {
      jobResults.push({
        ...result,
        matrixValues: Object.keys(rj.matrixValues).length > 0 ? rj.matrixValues : undefined,
      });
    } else if (dagResult.skipped.includes(rj.expandedName)) {
      jobResults.push({
        name: rj.expandedName,
        status: 'skipped',
        durationMs: 0,
        steps: [],
        matrixValues: Object.keys(rj.matrixValues).length > 0 ? rj.matrixValues : undefined,
      });
    } else if (dagResult.cancelled.includes(rj.expandedName)) {
      jobResults.push({
        name: rj.expandedName,
        status: 'cancelled',
        durationMs: 0,
        steps: [],
        cancelled: true,
        matrixValues: Object.keys(rj.matrixValues).length > 0 ? rj.matrixValues : undefined,
      });
    }
  }

  const workflowResult: WorkflowExecutionResult = {
    name: workflow.name,
    status: dagResult.status === 'success' ? 'success' : 'failure',
    jobs: jobResults,
    durationMs,
  };

  return { result: workflowResult, succeeded: dagResult.status === 'success' };
}

/**
 * Execute workflows locally -- the full compile-match-resolve-execute pipeline.
 *
 * @param options - CLI options from `kici run local`
 * @returns true if all workflows succeeded, false otherwise
 */
export async function executeLocal(options: RunLocalOptions): Promise<boolean> {
  const kiciDir = resolveKiciDir(options.kiciDir);

  // 1. Compile workflows
  const compileSuccess = await compileCommand({
    kiciDir,
    check: false,
    verbose: options.debug ?? false,
  });

  if (!compileSuccess) {
    process.exitCode = 2;
    return false;
  }

  // 2. Load workflows (discover runtime modules)
  const { workflows: workflowsWithSource } = await discoverWorkflows(kiciDir);
  const workflows = workflowsWithSource.map((w: { workflow: Workflow }) => w.workflow);

  if (workflows.length === 0) {
    logger.info(pc.yellow('No workflows found'));
    return true;
  }

  // Interactive picker: derive an event arg + workflow filter from user selection.
  if (options.pick) {
    try {
      const picked = await runPicker(workflows, { filterEvent: options.event });
      options = { ...options, event: picked.event, workflow: picked.workflow };
    } catch (err) {
      if (err instanceof PickerCancelledError) {
        logger.info(pc.yellow(err.message));
        return true;
      }
      throw err;
    }
  }

  if (!options.event) {
    logger.error(
      pc.red('Missing event argument. Pass an event (e.g. "push") or use --pick to select one.'),
    );
    process.exitCode = 2;
    return false;
  }

  // 3. Load secrets
  const secrets = await loadLocalSecrets(kiciDir, options.env);

  // 4. Build event payload
  const event = await generateEventPayload(options.event, options);

  // 5. Match triggers
  const lockWorkflows = workflowsToLockFormat(workflows);
  const decisions = matchAllWorkflows(lockWorkflows as any, event);

  // Find matched workflows
  let matchedWorkflows = workflows.filter((_, i) => decisions[i]?.matched);

  if (matchedWorkflows.length === 0) {
    logger.info(pc.gray('No workflows matched the event'));
    return true;
  }

  // 6. Apply --workflow filter
  if (options.workflow) {
    matchedWorkflows = matchedWorkflows.filter((w) => w.name === options.workflow);
    if (matchedWorkflows.length === 0) {
      logger.info(pc.yellow(`No workflow named "${options.workflow}" matched the event`));
      return true;
    }
  }

  // --json implies --quiet for streaming (only structured JSON goes to stdout)
  const isQuiet = Boolean(options.quiet || options.json);

  // 7. Resolve the execution directory: isolated tmp checkout by default,
  //    the real repo root with --in-place.
  const repoRoot = path.dirname(kiciDir);
  let materialized: MaterializedCheckout | null = null;
  let execDir = repoRoot;
  if (!options.inPlace) {
    // Collect checkouts retained by earlier failed/--keep runs once they are
    // older than the inspection window. Awaited: it is a cheap readdir + a
    // few rms, and being deterministic here keeps the behavior testable.
    await gcStaleRunCheckouts(process.env.KICI_RUN_DIR ?? os.tmpdir());
    materialized = await materializeCheckout(repoRoot, { runDir: process.env.KICI_RUN_DIR });
    execDir = materialized.path;
    logger.info(pc.gray(`running in ${execDir}`));
  }

  const concurrency = options.concurrency ?? getDefaultConcurrency();
  const failFast = !options.keepGoing;
  let allSucceeded = true;
  const workflowResults: WorkflowExecutionResult[] = [];

  const ctx: RunOneMatchedWorkflowContext = {
    options,
    isQuiet,
    event,
    secrets,
    kiciDir,
    execDir,
    concurrency,
    failFast,
  };

  try {
    for (const workflow of matchedWorkflows) {
      const outcome = await runOneMatchedWorkflow(workflow, ctx);
      if (outcome === null) continue; // filtered out
      workflowResults.push(outcome.result);
      if (!outcome.succeeded) {
        allSucceeded = false;
      }
    }

    // 8. Output results based on CLI flags
    if (options.json) {
      console.log(formatLocalJsonResult(workflowResults));
    } else if (options.junit) {
      const junitXml = formatLocalJunitResult(workflowResults);
      await writeFile(options.junit, junitXml);
      if (!isQuiet) {
        logger.info(pc.green(`JUnit XML written to ${options.junit}`));
      }
    }

    if (!isQuiet) {
      displayLocalSummary(workflowResults);
    }

    return allSucceeded;
  } finally {
    // Cleanup policy: remove the tmp checkout on success; keep it on failure
    // (logging the retained path) so it can be inspected. --keep always retains.
    if (materialized) {
      if (allSucceeded && !options.keep) {
        await materialized.cleanup();
      } else {
        logger.info(pc.gray(`kept isolated checkout at ${execDir}`));
      }
    }
  }
}

/**
 * Get default concurrency based on available CPU parallelism.
 */
function getDefaultConcurrency(): number {
  try {
    return os.availableParallelism();
  } catch {
    return os.cpus().length || 4;
  }
}
