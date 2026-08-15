import type { $ as Shell } from 'zx';
import type { ChangedFilesStatus } from '@kici-dev/engine';
import type { EventPayload } from './events/event-payloads.js';
import type { RepoInfo } from './context.js';

/**
 * Context handed to a workflow's `filter`, on an evaluating agent with the
 * tree(s) on disk. An organization-wide workflow is evaluated once per
 * (event × workflow repo), before any run row exists; a same-repo workflow is
 * evaluated once per dispatch-bound job and once per generator, where
 * `sourceRepo` and `workflowRepo` are the same repo. See `FilterFn` for what
 * that means for the predicate you write, and which jobs it skips.
 *
 * **The context carries no secrets.** Not because nothing has been resolved
 * yet — on the same-repo path a job's bound contexts, their vars and scoped
 * secrets, its context rules and its approval hold are all resolved BEFORE the
 * evaluating job is queued — but because this context deliberately does not
 * carry them. `filter` sees no `scoped_secrets` and no source-repo credentials
 * beyond the clone token, whichever path it runs on.
 *
 * `sourceRepo.path` is an absolute path on the evaluating agent. Its CONTENTS
 * are stable across evaluations and the later sandbox run; the path itself is
 * not (different workDir, possibly a different machine). Read through it; never
 * embed it in a job name, an output, or anything compared across calls.
 *
 * `sourceRepo.ref` and `sourceRepo.sha` are optional on `RepoInfo` and may be
 * absent for an event that carries no single ref — guard before reading them.
 */
export interface FilterContext {
  /** The repo whose push triggered this evaluation. */
  sourceRepo: RepoInfo;
  /** The repo that registered the workflow. Identical to `sourceRepo` for a non-global workflow. */
  workflowRepo: RepoInfo;
  /** Normalized event envelope that triggered this evaluation. */
  event: EventPayload;
  /**
   * Files changed in this event (push / pull_request diff, computed from the
   * checkout). Reading this throws `ChangedFilesUnavailableError` when the diff
   * is not available (`changedFilesStatus !== 'fetched'`) — e.g. a
   * schedule/tag/manual event. Guard with `changedFilesStatus` first when a
   * filter runs on such events:
   * `if (ctx.changedFilesStatus !== 'fetched') return true`.
   *
   * The throw is deliberate and mirrors `RuleContext.changedFiles`: a `false`
   * verdict dispatches none of the workflow's own jobs, so a silently-empty
   * list would make a path-based gate suppress it invisibly. How invisibly
   * depends on the path — an organization-wide workflow leaves no run at all,
   * a same-repo one leaves a `success` run carrying only its `__init__*`
   * evaluation jobs, whose log records the verdict.
   */
  changedFiles: string[];
  /** Availability of `changedFiles` (see `changedFiles`). */
  changedFilesStatus: ChangedFilesStatus;
  /** Environment variables. */
  env: Record<string, string | undefined>;
  /** zx shell executor. */
  $: typeof Shell;
}

/**
 * A workflow-level pre-dispatch predicate.
 *
 * **It must be pure and deterministic.** For an organization-wide workflow it is
 * called once per (event × workflow repo). For a same-repo workflow it is called
 * once for every job that reaches dispatch and once for every job generator, so
 * a workflow with ten jobs calls it ten times for one event, each on its own
 * agent with its own checkout and its own `ctx.$` shell. Two consequences to
 * design for: anything the predicate does — an API call, a shell command, a
 * write — happens that many times, so keep it cheap and side-effect free; and if
 * it can return different answers for the same event, the workflow will
 * partially dispatch, running some jobs and not others.
 *
 * "Reaches dispatch" excludes two same-repo cases: a job **held for approval**
 * and a job **rejected by a context rule** are never filtered. Each already has
 * a gate — the hold or the rule — so an approved job dispatches with no filter
 * verdict having been taken. A path filter therefore cannot stop an approval
 * request for a job the change does not concern.
 *
 * Decide from `ctx` alone — the event, the changed files, and the checked-out
 * tree — and the same event always yields the same verdict.
 */
export type FilterFn = (ctx: FilterContext) => boolean | Promise<boolean>;
