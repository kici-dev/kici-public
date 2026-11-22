/**
 * The history and tags `kici run remote` ships: the deepest checkout among the jobs that can run,
 * unless `--git-depth` / `--git-tags` / `--no-git-tags` sets that dimension. Over-shipping only
 * grows the overlay; under-shipping breaks a job.
 */

import {
  changedFilesStatusSchema,
  isLockStaticJob,
  matchAllWorkflows,
  type LockJobOrFactory,
  type LockWorkflow,
} from '@kici-dev/engine';
import type { RemoteGitCliFlags } from '../commands/remote-git-flags.js';
import type { FixtureEvent } from '../fixtures/event.js';
import { GitTagMode } from './shipped-git/git-ship-types.js';

export interface GitShipRequirement {
  /** Commits of history; 0 = full history. */
  depth: number;
  tags: GitTagMode;
  /** Why the requirement differs from the default, depth first; empty for the default. */
  reasons: string[];
}

/** What a standard checkout fetches: the current commit only. */
const DEFAULT_DEPTH = 1;

/** One requirement with the reason for each dimension kept apart, so a flag replaces one. */
interface Dimensions {
  depth: number;
  depthReason?: string;
  tags: GitTagMode;
  tagsReason?: string;
}

/** Whether `candidate` asks for more history than `current` (0 = full history beats any number). */
function isDeeper(candidate: number, current: number): boolean {
  if (current === 0) return false;
  return candidate === 0 || candidate > current;
}

function dimensionsFromJobs(jobs: readonly LockJobOrFactory[]): Dimensions {
  const dims: Dimensions = { depth: DEFAULT_DEPTH, tags: GitTagMode.Default };
  for (const job of jobs) {
    // Generated jobs are not in the lock; a `checkout: false` job never reads the repository.
    if (!isLockStaticJob(job) || job.checkout === false) continue;
    const fetchDepth = job.checkoutOptions?.fetchDepth;
    if (fetchDepth !== undefined && isDeeper(fetchDepth, dims.depth)) {
      dims.depth = fetchDepth;
      dims.depthReason = `job "${job.name}" asks for fetchDepth ${fetchDepth}`;
    }
    if (job.checkoutOptions?.fetchTags === true && dims.tagsReason === undefined) {
      dims.tags = GitTagMode.All;
      dims.tagsReason = `job "${job.name}" asks for tags`;
    }
  }
  return dims;
}

function toRequirement(dims: Dimensions): GitShipRequirement {
  return {
    depth: dims.depth,
    tags: dims.tags,
    reasons: [dims.depthReason, dims.tagsReason].filter((r): r is string => r !== undefined),
  };
}

/**
 * The deepest `fetchDepth` among `jobs` (0 beats any number), and every tag when one sets
 * `fetchTags: true`. Each reason names the first job, in lock order, that asks for it.
 */
export function requirementFromJobs(jobs: readonly LockJobOrFactory[]): GitShipRequirement {
  return toRequirement(dimensionsFromJobs(jobs));
}

/**
 * The jobs a remote run can execute: `workflowName`'s, else those of every workflow `event`
 * matches (path filters match: the changed files are unknown), else every job, also when matching
 * throws. Counting too many only ships more.
 */
export function jobsInScope(
  lock: { workflows?: readonly LockWorkflow[] },
  scope: { workflowName?: string; event?: FixtureEvent },
): LockJobOrFactory[] {
  const workflows = lock.workflows ?? [];
  const jobsOf = (selected: readonly LockWorkflow[]) => selected.flatMap((w) => w.jobs ?? []);
  if (scope.workflowName !== undefined) {
    return jobsOf(workflows.filter((w) => w.name === scope.workflowName));
  }
  const { event } = scope;
  if (!event) return jobsOf(workflows);
  try {
    const decisions = matchAllWorkflows(workflows, {
      type: event.type,
      ...(event.action !== undefined && { action: event.action }),
      targetBranch: event.targetBranch,
      ...(event.sourceBranch !== undefined && { sourceBranch: event.sourceBranch }),
      payload: event.payload,
      changedFilesStatus: changedFilesStatusSchema.enum.unavailable,
    });
    const matched = workflows.filter((_, i) => decisions[i]?.matched);
    // fails-when: a trigger the CLI cannot evaluate (a `repos` filter with no
    // source repository) matches nothing and the run under-ships its jobs
    return jobsOf(matched.length > 0 ? matched : workflows);
  } catch {
    return jobsOf(workflows);
  }
}

/**
 * The requirement of the in-scope jobs, each git flag replacing its dimension and reason. An
 * unparsable lock gives the default.
 */
export function resolveGitShipRequirement(args: {
  inlineLockFile: string;
  workflowName?: string;
  event?: FixtureEvent;
  flags: Pick<RemoteGitCliFlags, 'gitDepth' | 'gitTags'>;
}): GitShipRequirement {
  let lock: { workflows?: readonly LockWorkflow[] } | undefined;
  try {
    lock = JSON.parse(args.inlineLockFile);
  } catch {
    lock = undefined;
  }
  const dims = lock
    ? dimensionsFromJobs(jobsInScope(lock, { workflowName: args.workflowName, event: args.event }))
    : { depth: DEFAULT_DEPTH, tags: GitTagMode.Default };
  const { gitDepth, gitTags } = args.flags;
  if (gitDepth !== undefined) {
    dims.depth = gitDepth;
    dims.depthReason = `--git-depth ${gitDepth}`;
  }
  if (gitTags !== undefined) {
    dims.tags = gitTags ? GitTagMode.All : GitTagMode.None;
    dims.tagsReason = gitTags ? '--git-tags' : '--no-git-tags';
  }
  return toRequirement(dims);
}

/** What ships, in words. Full history carries every tag unless tags are off. */
function shipmentWords(req: GitShipRequirement): string {
  if (req.depth === 0) {
    return req.tags === GitTagMode.None ? 'full history, no tags' : 'full history + tags';
  }
  const tags = {
    [GitTagMode.Default]: 'default tags',
    [GitTagMode.All]: 'all tags',
    [GitTagMode.None]: 'no tags',
  }[req.tags];
  return `depth ${req.depth}, ${tags}`;
}

/** The `Git: …` line: what the remote workspace's `.git` holds, and why. */
export function describeGitShipment(req: GitShipRequirement): string {
  const why = req.reasons.length > 0 ? req.reasons.join('; ') : 'default';
  return `Git: ${shipmentWords(req)} (${why})`;
}
