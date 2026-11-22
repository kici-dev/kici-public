/** Types of the fresh-clone `.git` that `kici run remote` ships in its overlay. */

import type { OverlayGitRecord } from '@kici-dev/engine';

/** Which tags the shipped `.git` carries. */
export enum GitTagMode {
  /** git's default: the tags that point at shipped commits (every tag at depth 0). */
  Default = 'default',
  /** Every tag, as `git fetch --tags`. */
  All = 'all',
  /** No tags, as `git clone --no-tags`. */
  None = 'none',
}

/** The developer repository's object format, as `git rev-parse --show-object-format` prints it. */
export enum GitObjectFormat {
  Sha1 = 'sha1',
  Sha256 = 'sha256',
}

export interface GitShipOptions {
  /** Commits of real history; 0 = full history plus every branch and tag. */
  depth: number;
  tags: GitTagMode;
  /** true: changes become a synthetic commit on HEAD; else (`--no-commit`) they stay uncommitted. */
  commit?: boolean;
  /** Absent: SYNTHETIC_COMMIT_MESSAGE (buildShippedGit applies the default). */
  commitMessage?: string;
  /** Absent: resolveSyntheticAuthor(repoRoot) (buildShippedGit applies the default). */
  commitAuthor?: GitIdentity;
  /** Annotated tags (`--tag`) at the workspace commit, whatever `tags` says. */
  syntheticTags?: readonly string[];
}

/** The message of the synthetic commit that holds the developer's uncommitted changes. */
export const SYNTHETIC_COMMIT_MESSAGE = 'kici: working-tree snapshot';

export interface GitIdentity {
  name: string;
  email: string;
}

/** The identity of commits KiCI writes when the developer has none configured. */
export const KICI_GIT_IDENTITY: GitIdentity = { name: 'KiCI', email: 'noreply@kici.dev' };

export interface ShippedGit {
  /**
   * Holds only `.git/`; moved beside the tarball, into the temp dir the caller removes, since
   * `kici run remote` reads its objects to list the event's changed files.
   */
  root: string;
  /** `.git/…` paths relative to `root`, in pack order. */
  files: string[];
  /** The developer's HEAD. */
  baseSha: string;
  /** The commit the remote workspace checks out: the synthetic commit, or the developer's HEAD. */
  workspaceSha: string;
  /** Whether `workspaceSha` is a synthetic commit of the uncommitted changes on top of `baseSha`. */
  synthetic: boolean;
  /**
   * Files shipping from `root` with the bytes and mode a default-config checkout writes, where
   * they differ from the developer's (CRLF under `core.autocrlf`, an executable bit under
   * `core.fileMode=false`). Absent when all match; `root` is removed once packed.
   */
  checkout?: { root: string; paths: string[] };
  /** Parent of `workspaceSha`, when it exists in the shipped or developer repo. */
  parentSha?: string;
  /**
   * Under `--no-commit`, the sorted paths modified, staged, untracked or deleted within the
   * selection, which differ from `workspaceSha` remotely. Absent with a synthetic commit or no change.
   */
  uncommittedPaths?: string[];
  /** The synthetic tags created at `workspaceSha`, each once, in request order. */
  createdTags: string[];
  /** The synthetic tags that replaced a developer tag of the same name the shipped repository held. */
  replacedTags: string[];
  /** Checked-out branch; undefined on a detached HEAD. */
  branch?: string;
  /** What the manifest records for the agent's history-gap check. */
  record: OverlayGitRecord;
  /** Messages for the developer, such as a shallow local repository that holds less history than requested. */
  warnings: string[];
}

export type ShippedGitResult = { git: ShippedGit } | { skipped: string };
