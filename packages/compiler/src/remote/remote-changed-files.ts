/**
 * The changed files `kici run remote` sends with an event, from local history, so path filters
 * and `ctx.changedFiles` match without the agent fetching from a git host.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PR_EVENT_FAMILY, type FixtureEvent } from '../fixtures/event.js';

export interface RemoteChangedFiles {
  /** Repo-relative paths, sorted. Absent when the run sends no list. */
  files?: string[];
  /** One line for the developer when the list cannot be computed. */
  warning?: string;
}

/** Large histories can list many paths; the default 1 MiB buffer is too small. */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Read-only git in the developer's repository, also reading the shipped objects so a synthetic
 * commit resolves. No fetch, prompt or optional lock; undefined on a non-zero exit.
 */
function readGit(repoRoot: string, shipRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync(
      'git',
      [
        // As the agent's default `git diff --name-only`: verbatim, renames by new name, top-relative.
        '-c',
        'core.quotePath=false',
        '-c',
        'diff.renames=true',
        '-c',
        'diff.relative=false',
        '-C',
        repoRoot,
        ...args,
      ],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(shipRoot, '.git', 'objects'),
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  } catch {
    return undefined;
  }
}

/** `git diff --name-only -z` between two revisions, sorted; undefined when git fails. */
function diffNames(repoRoot: string, shipRoot: string, range: string[]): string[] | undefined {
  const out = readGit(repoRoot, shipRoot, [
    'diff',
    '--no-ext-diff',
    '--name-only',
    '-z',
    ...range,
    '--',
  ]);
  if (out === undefined) return undefined;
  return out
    .split('\0')
    .filter((p) => p.length > 0)
    .sort();
}

/** The warning for a fixture whose event carries no changed-files list. */
function noListWarning(reason: string): string {
  return `${reason}, so the run sends no changed files; the agent decides path filters and ctx.changedFiles.`;
}

/** The commit a local branch, else its `origin` remote-tracking branch, points at. */
function resolveBaseBranch(repoRoot: string, shipRoot: string, base: string): string | undefined {
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    const sha = readGit(repoRoot, shipRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ])?.trim();
    if (sha) return sha;
  }
  return undefined;
}

/**
 * The files a fixture's event changes, from the developer's full local history:
 *
 * - a push: `parentSha..workspaceSha` (the synthetic commit's changes, or on a clean tree the
 *   last commit's);
 * - a pull request: the three-dot diff of the base branch against `workspaceSha`, so the synthetic
 *   commit's uncommitted changes count;
 * - other events and a parentless push: no list, and the agent decides. A missing base branch,
 *   one with no shared history, and a failing diff send no list with one warning naming why.
 *
 * Under `--no-commit`, the list also holds `uncommittedPaths`. `shipRoot` holds the shipped `.git`
 * (with the synthetic commit); the developer's repository is only read.
 */
export function computeRemoteChangedFiles(args: {
  repoRoot: string;
  shipRoot: string;
  event: FixtureEvent;
  workspaceSha: string;
  parentSha?: string;
  uncommittedPaths?: readonly string[];
}): RemoteChangedFiles {
  const { repoRoot, shipRoot, event, workspaceSha, parentSha } = args;
  const withUncommitted = (files: string[] | undefined, range: string): RemoteChangedFiles =>
    files
      ? { files: [...new Set([...files, ...(args.uncommittedPaths ?? [])])].sort() }
      : { warning: noListWarning(`git diff ${range} failed`) };

  if (event.type === 'push') {
    if (!parentSha) return {};
    const range = `${parentSha}..${workspaceSha}`;
    return withUncommitted(diffNames(repoRoot, shipRoot, [parentSha, workspaceSha]), range);
  }

  if (PR_EVENT_FAMILY.has(event.type)) {
    const base = event.targetBranch;
    const baseSha = resolveBaseBranch(repoRoot, shipRoot, base);
    if (!baseSha) return { warning: noListWarning(`Base branch '${base}' does not exist locally`) };
    if (readGit(repoRoot, shipRoot, ['merge-base', baseSha, workspaceSha]) === undefined) {
      return {
        warning: noListWarning(
          `Base branch '${base}' shares no history with the workspace commit in your local repository (a shallow clone, or unrelated histories)`,
        ),
      };
    }
    const range = `${baseSha}...${workspaceSha}`;
    return withUncommitted(diffNames(repoRoot, shipRoot, [range]), range);
  }

  return {};
}
