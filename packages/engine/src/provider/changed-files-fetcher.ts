/** Fetches a webhook event's changed files from the provider API, for path trigger filtering. */

import type { ProviderType } from './types.js';
import type { ChangedFilesStatus } from '../trigger/types.js';

/**
 * `status` separates an authoritative diff from a capability gap, so path
 * filters never infer a no-match from an empty list:
 * - `fetched` — authoritative; an empty `files` does NOT match a path filter.
 * - `unavailable` — no diff (e.g. a universal-git PR event with no per-commit
 *   diff in the body); path filters match conservatively.
 *
 * `skipped` is not a fetcher outcome: the pipeline sets it when no trigger has
 * path patterns and the fetch never runs.
 */
export interface ChangedFilesResult {
  files: string[];
  status: Extract<ChangedFilesStatus, 'fetched' | 'unavailable'>;
}

export interface ChangedFilesFetcher {
  readonly provider: ProviderType;

  /**
   * For a PR, the files changed in the pull/merge request; for a push, across
   * the pushed commits. Paths are relative to the repo root.
   *
   * @param repoIdentifier - e.g. "owner/repo" for GitHub
   * @param eventType - "pull_request" or "push"
   */
  getChangedFiles(
    repoIdentifier: string,
    eventType: string,
    payload: unknown,
    credentials: unknown,
  ): Promise<ChangedFilesResult>;
}
