/**
 * The four evaluations the eval child performs, with the IPC shell factored out.
 *
 * Separated from `eval-runner.ts` so this — the code that actually loads and
 * runs a customer workflow module — is directly testable, and so a unit test can
 * drive the real evaluation through the same seam the child uses rather than a
 * hand-written imitation of it that would drift.
 *
 * Every `process.env` read below is correct BECAUSE it runs in the eval child:
 * there `process.env` is the sanitized environment the child was forked with,
 * carrying no agent credential. The same expressions were the defect while these
 * evaluations ran in the agent process, which is why they moved rather than
 * being rewritten.
 */

import { join } from 'node:path';
import type { JobDispatch, LockJob, LogStream } from '@kici-dev/engine';
import type { DynamicJobContext } from '@kici-dev/sdk';
import type { EvalRequest } from './ipc-protocol.js';
import { runCaptured, type CaptureSink } from '../console-capture.js';
import { loadWorkflowSource, extractWorkflow } from '../workflow-loader.js';
import {
  evaluateDynamicFields,
  evaluateWorkflowFilter,
  type FilterEvalInput,
} from '../init-runner.js';
import {
  buildEvalNeedsContext,
  buildEvalShell,
  buildGlobalFilterInput,
  buildInitFilterInput,
  buildRoundRepos,
  DEFAULT_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS,
  DEFAULT_GLOBAL_EVAL_ROUND_TIMEOUT_MS,
  resolveEvalChangedFiles,
  type GlobalWorkflowRepoFields,
} from '../eval-context.js';
import { buildGeneratorContext, type GeneratorRepoPair } from '../generator-context.js';
import { applyGlobalWorkflowEnv } from '../global-workflow-env.js';
import { jobWorkspaceLayout } from '../job-workspace-layout.js';
import { serializeJobsToLock } from '../dynamic-job-serializer.js';
import { runGlobalEvalRound } from '../global-eval-runner.js';
import type { GlobalEvalRoundJobConfig } from '../global-eval-types.js';
import { withTimeout } from '../timeout-util.js';

/** What an evaluation needs from its host: a log sink and the `ctx.kici` API. */
export interface EvalDispatchDeps {
  emit: (line: string, stream?: LogStream) => void;
  kici: DynamicJobContext['kici'];
}

/** Console output captured inside an evaluation lands on the job's step-0 log. */
function makeSink(deps: EvalDispatchDeps): CaptureSink {
  return { addLine: (line) => deps.emit(line) };
}

/** A logger shaped like the SDK's, routing every level onto the same log. */
function makeEvalLogger(deps: EvalDispatchDeps) {
  return {
    info: (msg: string) => deps.emit(msg),
    warn: (msg: string) => deps.emit(`WARN: ${msg}`),
    error: (msg: string) => deps.emit(`ERROR: ${msg}`),
    debug: (msg: string) => deps.emit(`DEBUG: ${msg}`),
  };
}

/**
 * Where one of a run's evaluation jobs loads the workflow module, and the repo
 * pair its customer code sees.
 *
 * A global workflow's module is loaded from the workflow repository's checkout,
 * and its code sees that checkout and the source repository's as the pair every
 * other evaluation of it gets. Any other workflow loads from the work dir and
 * gets no pair.
 */
interface EvalTarget {
  workflowDir: string;
  repos?: GeneratorRepoPair;
}

function evalTarget(request: EvalRequest): EvalTarget {
  const layout = jobWorkspaceLayout(request.config, request.workDir);
  if (!layout.isGlobal) return { workflowDir: layout.workflowDir };
  const dispatch = request.dispatch as unknown as JobDispatch;
  const repos = buildRoundRepos(
    dispatch,
    request.config as unknown as GlobalWorkflowRepoFields,
    layout.workflowDir,
    layout.sourceDir,
  );
  return { workflowDir: layout.workflowDir, repos };
}

/**
 * Run an evaluation with a global workflow's `KICI_*` keys set, as the round and
 * the sandbox set them for the same workflow, and restore them afterwards. Runs
 * `fn` unchanged for any other workflow.
 */
async function withGlobalWorkflowEnv<T>(target: EvalTarget, fn: () => Promise<T>): Promise<T> {
  if (!target.repos) return fn();
  const restoreEnv = applyGlobalWorkflowEnv(target.repos);
  try {
    return await fn();
  } finally {
    restoreEnv();
  }
}

/** The context a `filter` sees in one of a run's evaluation jobs. */
function buildJobFilterInput(
  request: EvalRequest,
  target: EvalTarget,
  event: Record<string, unknown>,
  deps: EvalDispatchDeps,
): Promise<FilterEvalInput> {
  const dispatch = request.dispatch as unknown as JobDispatch;
  // fails-when: a global workflow's filter sees the source repository under both names
  // breaks-if-wrong: a same-repo workflow's filter keeps one repository under both names
  if (target.repos) {
    return buildGlobalFilterInput(
      dispatch,
      request.config as unknown as GlobalWorkflowRepoFields,
      event,
      request.workDir,
      deps.emit,
    );
  }
  return buildInitFilterInput(dispatch, event, request.workDir, deps.emit);
}

/** The `jobConfig` fields an init job's evaluation reads. */
interface InitEvalConfig {
  targetJobName: string;
  workflowName: string;
  source: string;
  dynamicContext: boolean;
  dynamicEnv: boolean;
  dynamicConcurrencyGroup: boolean;
  dynamicMatrix?: boolean;
  hasFilter?: boolean;
  event: Record<string, unknown>;
  timeoutMs?: number;
  contentHash?: string;
  resolvedHashFiles?: string[];
}

async function runInit(request: EvalRequest, deps: EvalDispatchDeps): Promise<unknown> {
  const config = request.config as unknown as InitEvalConfig;
  const target = evalTarget(request);
  return withGlobalWorkflowEnv(target, async () => {
    // Built before the capture scope because it clones and shells out; the filter
    // call itself runs inside the scope with everything else.
    const filterInput = config.hasFilter
      ? await buildJobFilterInput(request, target, config.event, deps)
      : undefined;
    return runCaptured(makeSink(deps), () => evaluateInit(target, config, filterInput, deps));
  });
}

/** Load the workflow module and evaluate the target job's filter and dynamic fields. */
async function evaluateInit(
  target: EvalTarget,
  config: InitEvalConfig,
  filterInput: FilterEvalInput | undefined,
  deps: EvalDispatchDeps,
): Promise<unknown> {
  // fails-when: a global workflow's module is loaded from the source repository's clone
  const { module } = await loadWorkflowSource(
    target.workflowDir,
    config.source,
    config.contentHash,
    config.resolvedHashFiles,
  );
  const workflow = extractWorkflow(module, config.workflowName);
  deps.emit(
    `Evaluating dynamic fields for job '${config.targetJobName}' (env=${config.dynamicEnv} context=${config.dynamicContext} concurrencyGroup=${config.dynamicConcurrencyGroup} matrix=${config.dynamicMatrix ?? false} filter=${config.hasFilter ?? false})`,
  );
  return evaluateDynamicFields(
    workflow,
    config.targetJobName,
    config.event,
    {
      dynamicContext: config.dynamicContext,
      dynamicEnv: config.dynamicEnv,
      dynamicConcurrencyGroup: config.dynamicConcurrencyGroup,
      dynamicMatrix: config.dynamicMatrix ?? false,
      hasFilter: config.hasFilter ?? false,
    },
    config.timeoutMs,
    filterInput,
  );
}

async function runDynamicJob(request: EvalRequest, deps: EvalDispatchDeps): Promise<LockJob[]> {
  const config = request.config as {
    workflowName: string;
    source: { file: string; index: number };
    event: Record<string, unknown>;
    timeoutMs?: number;
    hasFilter?: boolean;
    contentHash?: string;
    resolvedHashFiles?: string[];
    resultAware?: boolean;
    declaredNeeds?: readonly unknown[];
    upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot;
  };
  const timeoutMs = config.timeoutMs ?? 60_000;
  const target = evalTarget(request);

  const scopedDollar = await buildEvalShell(request.workDir, deps.emit);
  return withGlobalWorkflowEnv(target, async () => {
    const filterInput = config.hasFilter
      ? await buildJobFilterInput(request, target, config.event, deps)
      : undefined;

    return runCaptured(makeSink(deps), async () => {
      // fails-when: a global workflow's module is loaded from the source repository's clone
      const { module } = await loadWorkflowSource(
        target.workflowDir,
        config.source.file,
        config.contentHash,
        config.resolvedHashFiles,
      );
      deps.emit('Workflow loaded');

      const { extractDynamicJobFn } = await import('../workflow-loader.js');
      const workflow = extractWorkflow(module, config.workflowName);

      if (config.hasFilter) {
        if (!(await evaluateWorkflowFilter(workflow, config.event, filterInput, timeoutMs))) {
          deps.emit(
            `Workflow filter returned false — '${config.workflowName}' does not apply to this ` +
              `event, so its generator is not run and no jobs are generated`,
          );
          return [];
        }
      }

      const dynamicFn = extractDynamicJobFn(workflow, config.source.index);
      deps.emit(`Evaluating DynamicJobFn (index ${config.source.index}, timeout ${timeoutMs}ms)`);

      const needs = buildEvalNeedsContext(config);
      const context = buildGeneratorContext({
        workflowName: config.workflowName,
        event: config.event,
        // The sanitized environment this child was forked with — no agent
        // credential is in it, which is the whole point of the child.
        env: process.env as Record<string, string | undefined>,
        ...(needs && { needs }),
        // The pair the sandbox re-evaluation of the same generator gets.
        // fails-when: a global generator reads ctx.sourceRepo here and finds nothing
        ...(target.repos && { repos: target.repos }),
        $: scopedDollar,
        log: makeEvalLogger(deps),
        kici: deps.kici,
      });

      const generatedJobs = await withTimeout(
        () => dynamicFn(context),
        timeoutMs,
        `DynamicJobFn index ${config.source.index} in workflow '${config.workflowName}'`,
      );

      return serializeJobsToLock(generatedJobs, {
        event: config.event,
        $: scopedDollar,
        log: makeEvalLogger(deps),
        env: process.env as Record<string, string | undefined>,
        workflowName: config.workflowName,
      });
    });
  });
}

/**
 * Load the workflow module to verify the cloned source matches the lock file's
 * `contentHash`, before the agent packs the source tarball.
 *
 * The verification is `loadWorkflowSource`'s own, and importing the module is
 * what makes it customer code — module top-level runs.
 */
async function runBuildVerify(request: EvalRequest, deps: EvalDispatchDeps): Promise<unknown> {
  const config = request.config as {
    sourceFile: string;
    contentHash?: string;
    resolvedHashFiles?: string[];
  };
  await runCaptured(makeSink(deps), () =>
    loadWorkflowSource(
      request.workDir,
      config.sourceFile,
      config.contentHash,
      config.resolvedHashFiles,
    ),
  );
  return null;
}

async function runGlobalEval(request: EvalRequest, deps: EvalDispatchDeps): Promise<unknown> {
  const dispatch = request.dispatch as unknown as JobDispatch;
  const config = request.config as unknown as GlobalEvalRoundJobConfig;
  const workflowDir = join(request.workDir, 'workflow');
  const sourceDir = join(request.workDir, 'source');

  const diff = await resolveEvalChangedFiles(dispatch, config.event, sourceDir);
  // cwd is the round's workDir — the PARENT of workflow/ and source/ — matching
  // what the sandbox re-evaluation hands the same generator.
  const evalShell = await buildEvalShell(request.workDir, deps.emit);

  return runCaptured(makeSink(deps), () =>
    runGlobalEvalRound({
      workflowDir,
      sourceDir,
      repos: buildRoundRepos(dispatch, config, workflowDir, sourceDir),
      candidates: config.candidates,
      event: config.event,
      changedFiles: diff.files,
      changedFilesStatus: diff.status,
      roundTimeoutMs: config.roundTimeoutMs ?? DEFAULT_GLOBAL_EVAL_ROUND_TIMEOUT_MS,
      candidateTimeoutMs: config.candidateTimeoutMs ?? DEFAULT_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS,
      $: evalShell,
      log: makeEvalLogger(deps),
      kici: deps.kici,
    }),
  );
}

/**
 * Run one evaluation request. The single entry point the eval child's IPC shell
 * calls, and the seam a unit test drives.
 */
export async function runEvalRequest(
  request: EvalRequest,
  deps: EvalDispatchDeps,
): Promise<unknown> {
  switch (request.kind) {
    case 'init':
      return runInit(request, deps);
    case 'dynamic-job':
      return runDynamicJob(request, deps);
    case 'build-verify':
      return runBuildVerify(request, deps);
    case 'global-eval':
      return runGlobalEval(request, deps);
  }
}
