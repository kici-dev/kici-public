/**
 * The pre-run global eval round.
 *
 * One round runs per (event × workflow repo), on an agent that already holds
 * both trees on disk. For each candidate global workflow it runs the workflow's
 * `filter` — deciding whether the workflow applies to the source repo at all —
 * and, for a survivor, its `DynamicJobFn`s, so the orchestrator can dispatch
 * generated jobs it could not otherwise see. The round precedes every run row:
 * a `filter` returning `false` means no run is created.
 *
 * Shape is modelled on `init-runner.ts` — load the module, resolve the target,
 * evaluate under `withTimeout`, return a structured result. As there, author
 * code runs in the agent's ordinary module loader: no `vm`, no `new Function`,
 * no dynamic `eval`.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **One bad candidate never sinks the round.** A candidate whose filter or
 *   generator throws, or that blows its budget, comes back
 *   `{ run: false, indeterminate: true, reason }` while its siblings carry real
 *   verdicts. Several unrelated org-wide workflows share a round; a single
 *   broken filter suppressing all of them would be a silent outage.
 * - **Candidates are STARTED sequentially.** They share one checkout and one
 *   working directory, so a parallel `$` would race on cwd. This is a strict
 *   guarantee on the happy path and **best-effort past a timeout**: `withTimeout`
 *   races rather than cancels, so a candidate that blew its own budget is still
 *   running when the next one starts. Nothing can preempt user code mid-`await`,
 *   so the round bounds the damage rather than eliminating it — the loop stops
 *   at the round deadline (and on the caller's abort signal), which caps the
 *   overlap at one orphaned candidate instead of the whole remaining queue.
 */

import type { Workflow, RepoInfo, DynamicJobContext, Logger } from '@kici-dev/sdk';
import { $ as ambientShell, type $ as Shell } from 'zx';
import { isDynamicJobFn, createFilterContext, buildKiciApi } from '@kici-dev/sdk';
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

/** One workflow the round must decide on, as the lock file describes it. */
export interface GlobalEvalCandidate {
  workflowName: string;
  /** Repo-relative path of the workflow module inside the workflow checkout. */
  sourceFile: string;
  /** From `LockWorkflow.hasFilter` — skip the filter call entirely when false. */
  hasFilter: boolean;
}

/** Arguments for {@link runGlobalEvalRound}. */
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
   * Caller's cancellation signal. The round stops starting new candidates once
   * it fires; the one already in flight cannot be preempted (see the module
   * doc comment) but its verdict is discarded.
   */
  signal?: AbortSignal;
  /** zx shell handed to filters and generators. Defaults to the ambient `$`. */
  $?: typeof Shell;
  /** Logger handed to generators. Defaults to a no-op. */
  log?: Logger;
  /** KiCI API handed to generators. Defaults to one that rejects every call. */
  kici?: DynamicJobContext['kici'];
  /**
   * Module loader seam. Defaults to `loadWorkflowSource` against `workflowDir`;
   * a caller that already holds the modules (or a unit test) supplies its own.
   */
  loadModule?: (sourceFile: string) => Promise<Record<string, unknown>>;
}

/** Per-round state shared by every candidate helper. */
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

/** Load a workflow, caching per source file so a shared module is imported once. */
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
 * Run every `DynamicJobFn` the workflow declares and serialize the result.
 *
 * The generator context is built through `buildGeneratorContext` with the same
 * repo pair the sandbox re-evaluation gets, so the two calls a generator
 * receives cannot drift apart. Returns `undefined` when the workflow declares
 * no generators, which keeps the `jobs` key off the wire entirely.
 */
async function generateDynamicJobs(
  workflow: Workflow,
  shared: RoundState,
): Promise<LockJob[] | undefined> {
  const { args } = shared;
  const generators = workflow.jobs.filter(isDynamicJobFn);
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

/**
 * Evaluate one candidate to a verdict: run its `filter` if it declares one,
 * then its generators if it survives.
 */
async function evaluateCandidateInner(
  candidate: GlobalEvalCandidate,
  shared: RoundState,
): Promise<GlobalEvalCandidateResult> {
  const { args } = shared;
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

/**
 * Evaluate one candidate, never throwing. A failure — a throwing filter, a
 * broken generator, a blown per-candidate budget — becomes an indeterminate
 * verdict so the round's other candidates still get real answers.
 */
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
 * Evaluate candidates one at a time — they share one checkout and one working
 * directory, so a parallel `$` would race on cwd.
 *
 * Stops before starting a candidate once the round deadline has passed or the
 * caller aborted. That check is what keeps the sequential guarantee meaningful
 * past a timeout: `withTimeout` races rather than cancels, so without it the
 * loop would keep launching every remaining candidate — each up to
 * `candidateTimeoutMs` — into a work directory the job has already reported on
 * and whose cleanup has already deleted. With it, at most one candidate is ever
 * in flight past the deadline.
 *
 * Results are appended to the caller's array as they land, so a round that
 * blows its own budget can still report the verdicts it did establish rather
 * than discarding the work.
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
 * Run one global eval round and return every candidate's verdict, in candidate
 * order. Never throws: a round that exceeds `roundTimeoutMs` reports whatever
 * it established and marks the rest indeterminate.
 */
export async function runGlobalEvalRound(
  args: GlobalEvalRoundArgs,
): Promise<GlobalEvalRoundResult> {
  // Set the seven KICI_* keys BEFORE evaluating anything. `buildGeneratorContext`
  // keeps the round's and the sandbox's generator contexts identical in shape,
  // but the generator's `env` is `process.env` — a generator reading
  // KICI_SOURCE_REPO_PATH here and in the sandbox must see the same value, or
  // its two evaluations disagree and the job fails on a determinism check.
  //
  // The restorer is NOT optional here: this runs in the long-lived agent
  // process, so leaving the keys set would hand the next job's non-global
  // generator a stale global-workflow world its own sandbox re-evaluation
  // never sees.
  const restoreEnv = applyGlobalWorkflowEnv(args.repos);

  // `withTimeout` races rather than cancels, so on a round timeout the loop may
  // still be running and still appending. Copy out of `settled` instead of
  // returning it, or the caller's result object would keep mutating after the
  // round reported.
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

  // The loop can also stop short WITHOUT throwing — its own deadline / abort
  // check returns cleanly — so pad on both paths rather than only in `catch`.
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
