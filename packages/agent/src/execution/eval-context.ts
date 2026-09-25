/**
 * Context builders shared by every customer-code EVALUATION.
 *
 * Split out of `job-runner.ts` so the eval child can import them without
 * dragging in the agent's job orchestrator (dockerode, the sandbox backends, the
 * orchestrator WebSocket client). The child is the process that loads and runs
 * customer workflow modules, so what it imports is part of its boundary.
 *
 * Every `process.env` read below is deliberate and correct **in the eval child**:
 * there `process.env` is the sanitized environment the child was forked with,
 * carrying no agent credential. The same expressions were the defect while these
 * functions ran in the agent process, which is why they moved rather than being
 * rewritten.
 */

import { join } from 'node:path';
import type { JobDispatch, LogStream, ChangedFilesStatus } from '@kici-dev/engine';
import type { DynamicJobNeed, RepoInfo, EventPayload } from '@kici-dev/sdk';
import { buildNeedsContext } from '@kici-dev/sdk/internal';
import type { $ as Shell } from 'zx';
import { gitClone, type GitAuth } from '../checkout/git-clone.js';
import { computeChangedFiles, type ChangedFilesResult } from '../checkout/changed-files.js';
import { repoIdentifierFromUrl } from './global-workflow-env.js';
import { makeStreamingZxLog } from './streaming-zx-log.js';
import type { FilterEvalInput } from './init-runner.js';
import type { GlobalEvalRoundJobConfig } from './global-eval-types.js';
import { globalWorkspaceLayout } from './job-workspace-layout.js';

export const DEFAULT_GLOBAL_EVAL_ROUND_TIMEOUT_MS = 120_000;
export const DEFAULT_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS = 20_000;

/** The workflow-repository fields a global workflow's evaluation job carries in its config. */
export type GlobalWorkflowRepoFields = Pick<
  GlobalEvalRoundJobConfig,
  'workflowRepoUrl' | 'workflowRef' | 'workflowSha' | 'workflowRepoIdentifier'
>;

/**
 * Build the source / workflow repo pair a global workflow's evaluation hands to
 * every filter and generator — in the round and in the run's own evaluation
 * jobs. Mirrors the sandbox's own `setupGlobalWorkflowEnv` construction so
 * a generator's two evaluations see the same identifiers, refs, and shas — only
 * the absolute paths differ, and those are never compared.
 */
export function buildRoundRepos(
  dispatch: JobDispatch,
  config: GlobalWorkflowRepoFields,
  workflowDir: string,
  sourceDir: string,
): { sourceRepo: RepoInfo; workflowRepo: RepoInfo } {
  return {
    workflowRepo: {
      identifier: config.workflowRepoIdentifier ?? repoIdentifierFromUrl(config.workflowRepoUrl),
      path: workflowDir,
      ref: config.workflowRef,
      sha: config.workflowSha,
    },
    sourceRepo: {
      identifier: repoIdentifierFromUrl(dispatch.repoUrl),
      path: sourceDir,
      ref: dispatch.ref,
      sha: dispatch.sha,
    },
  };
}

/**
 * Resolve the changed-files list a `filter` reads — for a global eval round and
 * for a filter-bearing init job alike.
 *
 * Ground truth is the agent's own source clone; an already-`fetched` list from
 * the orchestrator is a free fast-path. A diff-less event (schedule / tag /
 * manual) resolves to `unavailable`, which makes `ctx.changedFiles` throw
 * rather than read as an empty diff — a `filter` returning false produces no
 * run at all, so a silently-empty diff would suppress the workflow with no
 * artifact anywhere to inspect.
 */
export async function resolveEvalChangedFiles(
  dispatch: JobDispatch,
  event: Record<string, unknown>,
  sourceDir: string,
): Promise<ChangedFilesResult> {
  const ev = event as {
    changedFiles?: string[];
    changedFilesStatus?: ChangedFilesStatus;
  };
  if (ev.changedFilesStatus === 'fetched') {
    return { files: ev.changedFiles ?? [], status: 'fetched' };
  }
  // Same auth chain the source clone used (its own credentials were ephemeral).
  const sourceAuth = dispatch.sourceAuth ?? dispatch.workflowAuth;
  const auth: GitAuth | undefined =
    sourceAuth ??
    (dispatch.token
      ? { kind: 'basic', user: 'x-access-token', secret: dispatch.token }
      : undefined);
  return computeChangedFiles(sourceDir, event as EventPayload, auth);
}

/**
 * Directory an init job clones the source repo into when the workflow declares a
 * `filter` and the job restored `.kici/` from the cached tarball instead of
 * cloning. Named with the `__kici` prefix so it cannot collide with a repo path.
 */
const FILTER_SOURCE_DIRNAME = '__kici_filter_source__';

/**
 * Materialize the source tree a non-global workflow's `filter` reads through
 * `ctx.sourceRepo.path`.
 *
 * An init or dynamic-eval job normally restores only `.kici/` from the cached
 * source tarball — enough to import the workflow module, but a directory with no
 * repo in it. A filter that reads a file or shells out against that path would
 * get a confidently wrong answer, and `changedFiles` could not be computed at
 * all, so a filter-bearing job clones the source repo into a sibling directory.
 *
 * When no tarball was attached the job already cloned the whole repo into
 * `workDir`, and that clone is reused rather than duplicated — including the
 * local working-tree case, where there is no repo url and `workDir` IS the tree.
 *
 * A tarball with no repo url is the one combination that cannot be honoured:
 * `workDir` holds `.kici/` alone and there is nothing to clone from. Returning it
 * would hand the filter a directory in which every path test answers "absent" —
 * the exact silent lie this function exists to prevent — so it throws instead.
 */
export async function ensureFilterSourceDir(
  dispatch: JobDispatch,
  workDir: string,
): Promise<string> {
  if (!dispatch.sourceTarUrl) return workDir;
  if (!dispatch.repoUrl) {
    throw new Error(
      `Workflow declares a filter, but this job restored its source from the cache with no ` +
        `repo url to clone from — the filter would see an empty tree. Re-run with a source ` +
        `repository configured, or remove the filter.`,
    );
  }
  const sourceDir = join(workDir, FILTER_SOURCE_DIRNAME);
  const sourceAuth = dispatch.sourceAuth;
  await gitClone({
    repoUrl: dispatch.repoUrl,
    ref: dispatch.ref,
    sha: dispatch.sha,
    workDir: sourceDir,
    gitAuth: sourceAuth,
    token: sourceAuth ? undefined : dispatch.token,
  });
  return sourceDir;
}

/**
 * Build the context a non-global workflow's `filter` is evaluated against.
 *
 * `sourceRepo` and `workflowRepo` are the same repo — that is what "non-global"
 * means — so both carry the same identifier, path, ref, and sha. The zx shell is
 * rooted at the source tree and streams into the evaluating step's log, matching
 * what the global eval round hands its own filters.
 *
 * They are two distinct objects all the same. Being the same repo is a fact
 * about their VALUES, not a licence to hand the author one object under two
 * names: a filter that mutated `ctx.sourceRepo` would silently see
 * `ctx.workflowRepo` change with it, which happens on no other path.
 */
export async function buildInitFilterInput(
  dispatch: JobDispatch,
  event: Record<string, unknown>,
  workDir: string,
  emit: (line: string, stream: LogStream) => void,
): Promise<FilterEvalInput> {
  const sourceDir = await ensureFilterSourceDir(dispatch, workDir);
  const diff = await resolveEvalChangedFiles(dispatch, event, sourceDir);
  const repo: RepoInfo = {
    identifier: repoIdentifierFromUrl(dispatch.repoUrl),
    path: sourceDir,
    ref: dispatch.ref,
    sha: dispatch.sha,
  };
  return {
    sourceRepo: repo,
    workflowRepo: { ...repo },
    changedFiles: diff.files,
    changedFilesStatus: diff.status,
    env: process.env as Record<string, string | undefined>,
    $: await buildEvalShell(sourceDir, emit),
  };
}

/**
 * Build the context a global workflow's `filter` is evaluated against in one of
 * the run's own evaluation jobs: the same repo pair, diff and shell the round
 * hands the same filter. The source repository is the checkout under
 * `source/`, the workflow repository the one under `workflow/`, and the shell
 * is rooted at the work dir that holds both.
 */
export async function buildGlobalFilterInput(
  dispatch: JobDispatch,
  config: GlobalWorkflowRepoFields,
  event: Record<string, unknown>,
  workDir: string,
  emit: (line: string, stream: LogStream) => void,
): Promise<FilterEvalInput> {
  const { workflowDir, sourceDir } = globalWorkspaceLayout(workDir);
  const diff = await resolveEvalChangedFiles(dispatch, event, sourceDir);
  return {
    ...buildRoundRepos(dispatch, config, workflowDir, sourceDir),
    changedFiles: diff.files,
    changedFilesStatus: diff.status,
    env: process.env as Record<string, string | undefined>,
    $: await buildEvalShell(workDir, emit),
  };
}

/**
 * Build the per-invocation zx `$` a global eval round hands to filters and
 * generators, so a `await $\`…\`` inside one is visible in the eval step's log.
 *
 * **`env` is the LIVE `process.env` reference, never a spread.** A spread is a
 * snapshot taken when the shell is built, which is before the round applies the
 * seven `KICI_*` keys — so a filter that shells out (`$\`printenv
 * KICI_SOURCE_REPO_PATH\``, or any subprocess inheriting env) would see nothing
 * here while the sandbox re-evaluation's ambient `$` resolves `process.env`
 * after `setupGlobalWorkflowEnv` has run and does see them. That is the same
 * two-worlds determinism failure the cwd choice below exists to prevent, one
 * layer down. Passing the live reference reproduces the ambient `$`'s own
 * behaviour, which is what the sandbox uses.
 *
 * `verbose: true` + `makeStreamingZxLog` honors a per-call `quiet: true`, so a
 * decrypted secret never leaks into the log.
 *
 * `emit` is a callback rather than the `LogStreamer` itself so the caller can
 * route it through its own closed-guard: `LogStreamer.destroy()` sets no closed
 * flag and `addLine` buffers unconditionally, so a subprocess line arriving
 * after the step was reported would otherwise emit a `log.chunk` for a terminal
 * step. That is the likeliest path for it — an orphaned candidate is usually
 * orphaned *because* it is waiting on a subprocess.
 */
export async function buildEvalShell(
  cwd: string,
  emit: (line: string, stream: LogStream) => void,
): Promise<typeof Shell> {
  const { $: zx$ } = await import('zx');
  return zx$({
    cwd,
    env: process.env as Record<string, string>,
    verbose: true,
    quiet: false,
    log: makeStreamingZxLog(emit) as unknown as (entry: unknown) => void,
  }) as unknown as typeof Shell;
}

/**
 * Build the result-aware `ctx.needs` for a dynamic eval from its frozen upstream
 * snapshot. Returns undefined for an event-only generator (no snapshot).
 */
export function buildEvalNeedsContext(config: {
  resultAware?: boolean;
  declaredNeeds?: readonly unknown[];
  upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot;
}): ReturnType<typeof buildNeedsContext> | undefined {
  if (!config.resultAware || !config.upstreamSnapshot) return undefined;
  return buildNeedsContext(
    config.upstreamSnapshot,
    (config.declaredNeeds ?? []) as ReadonlyArray<DynamicJobNeed>,
  );
}
