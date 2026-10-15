/**
 * The pre-run global eval round: one per (event × workflow repo), on an agent
 * that already holds both trees on disk. For each candidate global workflow it
 * runs the `filter` (does the workflow apply to the source repo at all?) and,
 * for a survivor, its needs-free `DynamicJobFn`s, so the orchestrator can
 * dispatch generated jobs it could not otherwise see. The round precedes every
 * run row: a `filter` returning `false` means no run is created.
 *
 * Modelled on `init-runner.ts`: author code runs in the agent's ordinary module
 * loader — no `vm`, no `new Function`, no dynamic `eval`.
 *
 * Load-bearing and easy to lose:
 *
 * - **One bad candidate never sinks the round.** A candidate whose filter or
 *   generator throws, or that blows its budget, comes back
 *   `{ run: false, indeterminate: true, reason }` while its siblings carry real
 *   verdicts; one broken filter suppressing unrelated org-wide workflows would
 *   be a silent outage.
 * - **Candidates are STARTED sequentially.** They share one checkout and cwd, so
 *   a parallel `$` would race. Strict on the happy path, **best-effort past a
 *   timeout**: `withTimeout` races rather than cancels, and nothing can preempt
 *   user code mid-`await`, so a timed-out candidate is still running when the
 *   next starts. The loop stops at the round deadline (and on abort), capping
 *   the overlap at one orphaned candidate instead of the whole remaining queue.
 */

import type { Workflow, RepoInfo, DynamicJobContext, Logger } from '@kici-dev/sdk';
import { $ as ambientShell, type $ as Shell } from 'zx';
import { getDynamicJobNeeds, isDynamicJobFn, type DynamicJobFn } from '@kici-dev/sdk';
import { createFilterContext, buildKiciApi } from '@kici-dev/sdk/internal';
import type {
  ChangedFilesStatus,
  GlobalEvalCandidateResult,
  GlobalEvalRoundResult,
  LockJob,
} from '@kici-dev/engine';
import { withTimeout } from './timeout-util.js';
import { buildGeneratorContext } from './generator-context.js';
import { applyGlobalWorkflowEnv } from './global-workflow-env.js';
import { loadWorkflowSource, extractWorkflow } from './workflow-loader.js';
import { serializeJobsToLock } from './dynamic-job-serializer.js';
import { describePathsVerdict, evaluateDeferredPaths } from './deferred-paths.js';

/** One workflow the round must decide on, as the lock file describes it. */
export interface GlobalEvalCandidate {
  workflowName: string;
  /** Repo-relative path of the workflow module inside the workflow checkout. */
  sourceFile: string;
  /** From `LockWorkflow.hasFilter` — skip the filter call entirely when false. */
  hasFilter: boolean;
  /** The `paths` lists the orchestrator could only match conservatively; decided first. */
  deferredPaths?: string[][];
}

export interface GlobalEvalRoundArgs {
  /** Absolute path of the workflow-repo checkout (modules are loaded from here). */
  workflowDir: string;
  /** Absolute path of the source-repo checkout. */
  sourceDir: string;
  repos: { sourceRepo: RepoInfo; workflowRepo: RepoInfo };
  candidates: GlobalEvalCandidate[];
  /** The raw wire event, carrying the normalized event envelope. */
  event: Record<string, unknown>;
  changedFiles: string[];
  /**
   * Availability of `changedFiles`. Required, not defaulted: it feeds the
   * throwing accessor on `FilterContext`, and defaulting it to `'fetched'`
   * would let a diff-less event read as an empty diff and silently suppress
   * every path-gated workflow in the round.
   */
  changedFilesStatus: ChangedFilesStatus;
  /** Wall-clock budget for the whole round. */
  roundTimeoutMs: number;
  /** Wall-clock budget for one candidate (its filter plus its generators). */
  candidateTimeoutMs: number;
  /**
   * Once it fires the round starts no new candidates; the one in flight cannot
   * be preempted (see the module doc) but its verdict is discarded.
   */
  signal?: AbortSignal;
  /** For filters and generators. Defaults to the ambient `$`. */
  $?: typeof Shell;
  /** For generators. Defaults to a no-op. */
  log?: Logger;
  /** For generators. Defaults to one that rejects every call. */
  kici?: DynamicJobContext['kici'];
  /** Defaults to `loadWorkflowSource` against `workflowDir`. */
  loadModule?: (sourceFile: string) => Promise<Record<string, unknown>>;
}

interface RoundState {
  args: GlobalEvalRoundArgs;
  $: typeof Shell;
  log: Logger;
  kici: DynamicJobContext['kici'];
  loadModule: (sourceFile: string) => Promise<Record<string, unknown>>;
  /** Module load promises keyed by source file — several workflows share one file. */
  moduleCache: Map<string, Promise<Record<string, unknown>>>;
}

const NOOP_LOG: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function buildRoundState(args: GlobalEvalRoundArgs): RoundState {
  const loadModule =
    args.loadModule ??
    (async (sourceFile: string) => (await loadWorkflowSource(args.workflowDir, sourceFile)).module);
  return {
    args,
    $: args.$ ?? ambientShell,
    log: args.log ?? NOOP_LOG,
    // Same fallback shape the dynamic-eval job uses when no API transport is
    // wired: every call rejects rather than silently resolving to nothing.
    kici: args.kici ?? buildKiciApi(() => Promise.reject(new Error('Agent API not available'))),
    loadModule,
    moduleCache: new Map(),
  };
}

/** Caches per source file so a shared module is imported once. */
async function loadWorkflowCached(
  shared: RoundState,
  sourceFile: string,
  workflowName: string,
): Promise<Workflow> {
  let pending = shared.moduleCache.get(sourceFile);
  if (!pending) {
    pending = shared.loadModule(sourceFile);
    shared.moduleCache.set(sourceFile, pending);
  }
  return extractWorkflow(await pending, workflowName);
}

/**
 * True for a generator declared without upstream `needs`. A result-aware
 * generator (with `needs`) runs later on the run's deferred path, once its
 * upstreams produced their outputs. The compiler uses this same test to mark
 * the lock entry `resultAware`, so the round and the lock file cannot disagree.
 */
export function isRoundGeneratorFn(generator: DynamicJobFn): boolean {
  return getDynamicJobNeeds(generator) === undefined;
}

/**
 * The context comes from `buildGeneratorContext` with the same repo pair the
 * sandbox re-evaluation gets, so a generator's two calls cannot drift apart.
 * Returns `undefined` with no needs-free generator, keeping `jobs` off the wire.
 */
async function generateDynamicJobs(
  workflow: Workflow,
  shared: RoundState,
): Promise<LockJob[] | undefined> {
  const { args } = shared;
  // fails-when: a generator declared with `needs` runs in the round, with no upstream outputs
  // breaks-if-wrong: a needs-free generator must still run in the round
  const generators = workflow.jobs.filter(isDynamicJobFn).filter(isRoundGeneratorFn);
  if (generators.length === 0) return undefined;

  const serializerCtx = {
    event: args.event,
    $: shared.$,
    log: shared.log,
    env: process.env as Record<string, string | undefined>,
    workflowName: workflow.name,
  };

  const jobs: LockJob[] = [];
  const seenNames = new Set<string>();
  for (const generator of generators) {
    const context = buildGeneratorContext({
      workflowName: workflow.name,
      event: args.event,
      env: process.env as Record<string, string | undefined>,
      repos: args.repos,
      $: shared.$,
      log: shared.log,
      kici: shared.kici,
    });
    const generated = await generator(context);
    jobs.push(
      ...(await serializeJobsToLock(generated, serializerCtx, undefined, undefined, seenNames)),
    );
  }
  return jobs;
}

/** Deferred `paths`, then `filter`, then generators. A paths no-match returns before the module loads. */
async function evaluateCandidateInner(
  candidate: GlobalEvalCandidate,
  shared: RoundState,
): Promise<GlobalEvalCandidateResult> {
  const { args } = shared;
  if (candidate.deferredPaths?.length) {
    const diff = { files: args.changedFiles, status: args.changedFilesStatus };
    if (!evaluateDeferredPaths(candidate.deferredPaths, diff)) {
      return {
        workflowName: candidate.workflowName,
        run: false,
        reason: describePathsVerdict(candidate.deferredPaths, diff),
      };
    }
  }
  const workflow = await loadWorkflowCached(shared, candidate.sourceFile, candidate.workflowName);

  if (candidate.hasFilter) {
    if (typeof workflow.filter !== 'function') {
      throw new Error(
        `Workflow '${candidate.workflowName}' is recorded as declaring a filter, but its module ` +
          `exports none — the lock file is out of date. Run 'kici compile' and commit the result.`,
      );
    }
    const filterCtx = createFilterContext({
      sourceRepo: args.repos.sourceRepo,
      workflowRepo: args.repos.workflowRepo,
      event: args.event,
      changedFiles: args.changedFiles,
      changedFilesStatus: args.changedFilesStatus,
      env: process.env as Record<string, string | undefined>,
      $: shared.$,
    });
    if (!(await workflow.filter(filterCtx))) {
      return { workflowName: candidate.workflowName, run: false };
    }
  }

  const jobs = await generateDynamicJobs(workflow, shared);
  return { workflowName: candidate.workflowName, run: true, ...(jobs && { jobs }) };
}

/** Never throws: any failure, including a blown budget, becomes an indeterminate verdict. */
async function evaluateCandidate(
  candidate: GlobalEvalCandidate,
  shared: RoundState,
): Promise<GlobalEvalCandidateResult> {
  try {
    return await withTimeout(
      () => evaluateCandidateInner(candidate, shared),
      shared.args.candidateTimeoutMs,
      `global workflow '${candidate.workflowName}'`,
    );
  } catch (error) {
    return {
      workflowName: candidate.workflowName,
      run: false,
      indeterminate: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sequential (shared cwd). The deadline/abort check before each start keeps
 * that meaningful past a timeout: `withTimeout` races rather than cancels, so
 * without it the loop would launch every remaining candidate into a work
 * directory the job already reported on and cleanup already deleted. With it,
 * at most one candidate is in flight past the deadline.
 *
 * Results append to the caller's array as they land, so a round that blows its
 * budget still reports the verdicts it established.
 */
async function evaluateAllCandidates(
  shared: RoundState,
  into: GlobalEvalCandidateResult[],
  deadline: number,
): Promise<void> {
  for (const candidate of shared.args.candidates) {
    if (shared.args.signal?.aborted || Date.now() >= deadline) return;
    into.push(await evaluateCandidate(candidate, shared));
  }
}

/**
 * Returns every verdict in candidate order. Never throws: a round past
 * `roundTimeoutMs` reports what it established and marks the rest indeterminate.
 */
export async function runGlobalEvalRound(
  args: GlobalEvalRoundArgs,
): Promise<GlobalEvalRoundResult> {
  // Set the KICI_* keys BEFORE evaluating anything: the generator's `env` is
  // `process.env`, and a generator reading KICI_SOURCE_REPO_PATH must see the
  // same value here and in the sandbox, or the job fails a determinism check.
  // The restore is NOT optional: in the long-lived agent process, leftover keys
  // would hand the next job's non-global generator a stale global-workflow world.
  const restoreEnv = applyGlobalWorkflowEnv(args.repos);

  // On a round timeout the loop may still be appending (`withTimeout` does not
  // cancel), so copy out of `settled` rather than return it.
  const settled: GlobalEvalCandidateResult[] = [];
  let stopReason: string | undefined;
  try {
    const shared = buildRoundState(args);
    await withTimeout(
      () => evaluateAllCandidates(shared, settled, Date.now() + args.roundTimeoutMs),
      args.roundTimeoutMs,
      `global eval round (${args.candidates.length} candidate(s))`,
    );
  } catch (error) {
    stopReason = error instanceof Error ? error.message : String(error);
  } finally {
    restoreEnv();
  }

  // The loop can also stop short WITHOUT throwing (deadline / abort), so pad on both paths.
  const candidates = [...settled];
  const reason =
    stopReason ??
    (args.signal?.aborted
      ? 'global eval round was cancelled before this candidate was evaluated'
      : 'global eval round deadline reached before this candidate was evaluated');
  for (const candidate of args.candidates.slice(candidates.length)) {
    candidates.push({
      workflowName: candidate.workflowName,
      run: false,
      indeterminate: true,
      reason,
    });
  }
  return { candidates };
}
