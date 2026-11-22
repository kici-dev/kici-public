/**
 * The `kici run remote` flags that shape the remote `.git`, each checked before anything is
 * compiled or built.
 */

import type { GitIdentity } from '../remote/shipped-git/git-ship-types.js';
import {
  parseCommitAuthor,
  validateSyntheticTagName,
} from '../remote/shipped-git/synthetic-commit.js';

export interface RemoteGitCliFlags {
  /** `--git-depth`; absent: the depth the jobs ask for. */
  gitDepth?: number;
  /** true: `--git-tags`; false: `--no-git-tags`; absent: the tags the jobs ask for. */
  gitTags?: boolean;
  /** false with `--no-commit`: uncommitted changes stay uncommitted. */
  commit: boolean;
  /** `--commit-message`, as given; absent: the default message. */
  commitMessage?: string;
  /** `--commit-author`, parsed; absent: the developer's own identity. */
  commitAuthor?: GitIdentity;
  /** `--tag` names, each once, in the order given. */
  tags: string[];
}

/** A git flag value the CLI refuses; the CLI prints its message and exits 2. */
export class RemoteGitFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteGitFlagError';
  }
}

const NON_NEGATIVE_INTEGER = /^\d+$/;

function parseGitDepth(value: string): number {
  const depth = Number(value);
  // fails-when: '-1', '1.5', '1e3' or '' parse as a depth
  if (!NON_NEGATIVE_INTEGER.test(value) || !Number.isSafeInteger(depth)) {
    throw new RemoteGitFlagError(`--git-depth must be a non-negative integer, got '${value}'`);
  }
  return depth;
}

/** Run a validator, re-throwing its error as a RemoteGitFlagError with the same message. */
function asFlagError<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    throw new RemoteGitFlagError(err instanceof Error ? err.message : String(err));
  }
}

/** Parse and validate the raw Commander values; throws only `RemoteGitFlagError`. */
export function parseRemoteGitFlags(raw: {
  gitDepth?: string;
  gitTags?: boolean;
  commit?: boolean;
  commitMessage?: string;
  commitAuthor?: string;
  tag?: string[];
}): RemoteGitCliFlags {
  const gitDepth = raw.gitDepth === undefined ? undefined : parseGitDepth(raw.gitDepth);
  const commit = raw.commit ?? true;
  if (!commit && (raw.commitMessage !== undefined || raw.commitAuthor !== undefined)) {
    throw new RemoteGitFlagError(
      '--commit-message and --commit-author need a synthetic commit; drop --no-commit',
    );
  }
  // fails-when: an empty or blank message ships a synthetic commit with no subject
  if (raw.commitMessage !== undefined && raw.commitMessage.trim() === '') {
    throw new RemoteGitFlagError('--commit-message must not be empty');
  }
  const { commitAuthor: rawAuthor } = raw;
  const commitAuthor =
    rawAuthor === undefined ? undefined : asFlagError(() => parseCommitAuthor(rawAuthor));
  const tags = [...new Set(raw.tag ?? [])];
  for (const tag of tags) asFlagError(() => validateSyntheticTagName(tag));
  return {
    ...(gitDepth !== undefined && { gitDepth }),
    ...(raw.gitTags !== undefined && { gitTags: raw.gitTags }),
    commit,
    ...(raw.commitMessage !== undefined && { commitMessage: raw.commitMessage }),
    ...(commitAuthor && { commitAuthor }),
    tags,
  };
}
