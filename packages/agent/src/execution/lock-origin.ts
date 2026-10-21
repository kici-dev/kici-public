import { repoIdentifierFromUrl } from '@kici-dev/engine';

/**
 * The `owner/repo` whose `.kici/kici.lock.json` a job's lock entry came from, for
 * the compile-schema mismatch message.
 *
 * In order: the orchestrator's `lockRepoIdentifier` (set on the `__build__` job),
 * a global job's `workflowRepoIdentifier`, then the repository the clone URL
 * names. A clone URL's user-info is never echoed: it can carry a token.
 * `undefined` when nothing names a forge repository (a `file:` URL, a path).
 */
export function resolveLockRepo(dispatch: {
  repoUrl?: unknown;
  jobConfig?: Record<string, unknown>;
}): string | undefined {
  const fromConfig = (key: string): string | undefined => {
    const v = dispatch.jobConfig?.[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const named = fromConfig('lockRepoIdentifier') ?? fromConfig('workflowRepoIdentifier');
  if (named) return named;
  if (typeof dispatch.repoUrl !== 'string') return undefined;
  const repo = repoIdentifierFromUrl(dispatch.repoUrl);
  // A non-forge URL comes back unchanged apart from `.git`.
  if (repo === dispatch.repoUrl.replace(/\.git$/, '') || /[:@\\]/.test(repo)) return undefined;
  return repo;
}

/** Where a job's lock came from, as a compile-schema mismatch names it. */
export interface LockOrigin {
  /** `owner/repo` holding the lock; see {@link resolveLockRepo}. */
  repo?: string;
  /**
   * Set on a re-run: the repository and commit whose recorded lock it replays
   * (the orchestrator's `jobConfig.lockRerun`), so the error says a recompiled
   * lock reaches only a new event.
   */
  rerun?: { repo: string; sha: string };
}

/** The {@link LockOrigin} of a dispatched job. */
export function resolveLockOrigin(dispatch: {
  repoUrl?: unknown;
  jobConfig?: Record<string, unknown>;
}): LockOrigin {
  const rerun = dispatch.jobConfig?.lockRerun as { repo?: unknown; sha?: unknown } | undefined;
  const validRerun =
    rerun && typeof rerun.repo === 'string' && typeof rerun.sha === 'string' && rerun.sha
      ? { repo: rerun.repo, sha: rerun.sha }
      : undefined;
  const repo = resolveLockRepo(dispatch);
  return { ...(repo && { repo }), ...(validRerun && { rerun: validRerun }) };
}
