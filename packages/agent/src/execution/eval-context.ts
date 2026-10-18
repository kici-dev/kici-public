/**
 * Context builders for customer-code EVALUATION, kept apart from `job-runner.ts`
 * so the eval child (which loads customer workflow modules) does not import the
 * job orchestrator (dockerode, sandbox backends, the WebSocket client): what it
 * imports is part of its boundary.
 *
 * Every `process.env` read here is correct only **in the eval child**, where it
 * is the sanitized fork environment with no agent credential; in the agent
 * process the same expressions were the defect.
 */

import { join } from 'node:path';
import { repoIdentifierFromUrl } from '@kici-dev/engine';
import type { JobDispatch, LogStream, ChangedFilesStatus } from '@kici-dev/engine';
import type { DynamicJobNeed, RepoInfo, EventPayload } from '@kici-dev/sdk';
import { buildNeedsContext } from '@kici-dev/sdk/internal';
import type { $ as Shell } from 'zx';
import { gitClone } from '../checkout/git-clone.js';
import { computeChangedFiles, type ChangedFilesResult } from '../checkout/changed-files.js';
import { makeStreamingZxLog } from './streaming-zx-log.js';
import type { FilterEvalInput } from './init-runner.js';
import type { GlobalEvalRoundJobConfig } from './global-eval-types.js';
import { globalWorkspaceLayout } from './job-workspace-layout.js';

export type GlobalWorkflowRepoFields = Pick<
  GlobalEvalRoundJobConfig,
  'workflowRepoUrl' | 'workflowRef' | 'workflowSha' | 'workflowRepoIdentifier'
>;

/**
 * The source / workflow repo pair a global workflow's evaluation hands every
 * filter and generator, in the round and in the run's own evaluation jobs.
 * Mirrors the sandbox's `setupGlobalWorkflowEnv`, so both evaluations see the
 * same identifiers, refs and shas; only the never-compared absolute paths differ.
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
 * Changed files a `filter` reads, for a global eval round and a filter-bearing
 * init job alike. Ground truth is the agent's source clone; an orchestrator
 * list already `fetched` is a fast path. A diff-less event (schedule / tag /
 * manual) resolves to `unavailable`, so `ctx.changedFiles` throws instead of
 * reading as empty: a `filter` returning false creates no run, so an empty diff
 * would suppress the workflow with nothing to inspect.
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
  // The source clone's auth chain (its own credentials were ephemeral).
  const sourceAuth = dispatch.sourceAuth ?? dispatch.workflowAuth;
  return computeChangedFiles(sourceDir, event as EventPayload, sourceAuth);
}

/**
 * Where a filter-bearing init job that restored `.kici/` from the tarball
 * clones the source; the `__kici` prefix cannot collide with a repo path.
 */
const FILTER_SOURCE_DIRNAME = '__kici_filter_source__';

/**
 * Materialize the source tree a non-global `filter` reads via `ctx.sourceRepo.path`.
 *
 * An init or dynamic-eval job normally restores only `.kici/` from the cached
 * tarball, a directory with no repo in it: path tests would answer wrongly and
 * `changedFiles` could not be computed, so a filter-bearing job clones the
 * source into a sibling directory.
 *
 * With no tarball the job already cloned into `workDir`, which is reused
 * (including the local working-tree case, with no repo url).
 *
 * A tarball with no repo url leaves nothing to clone, and returning `workDir`
 * would make every path test answer "absent", so it throws.
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
  });
  return sourceDir;
}

/**
 * The context a non-global workflow's `filter` is evaluated against.
 *
 * Source and workflow are the same repo, so both carry the same identifier,
 * path, ref and sha, yet are distinct objects: a filter mutating
 * `ctx.sourceRepo` must not change `ctx.workflowRepo`, which no other path does.
 * The zx shell is rooted at the source tree and streams into the step's log,
 * as in the global eval round.
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
 * The context a global workflow's `filter` gets in one of the run's own
 * evaluation jobs: the same repo pair, diff and shell as in the round. Source
 * is under `source/`, workflow under `workflow/`, and the shell is rooted at
 * the work dir holding both.
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
 * Per-invocation zx `$` for filters and generators, so a `` $`…` `` inside one
 * shows in the eval step's log.
 *
 * **`env` is the LIVE `process.env`, never a spread.** A spread snapshots it
 * before the round applies the `KICI_*` keys, so a subprocess (`printenv
 * KICI_SOURCE_REPO_PATH`) would miss them while the sandbox re-evaluation's
 * ambient `$` sees them: a two-worlds determinism failure. The live reference
 * matches the ambient `$`.
 *
 * `verbose: true` + `makeStreamingZxLog` honors a per-call `quiet: true`, so a
 * decrypted secret never leaks into the log.
 *
 * `emit` is a callback, not the `LogStreamer`, so the caller can apply its own
 * closed-guard: `LogStreamer.destroy()` sets no closed flag and `addLine`
 * buffers unconditionally, so a late subprocess line would emit a `log.chunk`
 * for a terminal step. An orphaned candidate is usually orphaned *because* it
 * waits on a subprocess.
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
 * Result-aware `ctx.needs` for a dynamic eval, from its frozen upstream
 * snapshot; undefined for an event-only generator.
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
