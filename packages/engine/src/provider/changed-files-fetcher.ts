/**
 * ChangedFilesFetcher interface.
 *
 * Retrieves the list of files changed in a webhook event from the provider's API.
 * Used by the orchestrator for path-based trigger filtering.
 */

import type { ProviderType } from './types.js';
import type { ChangedFilesStatus } from '../trigger/types.js';

/**
 * Result of a changed-files fetch.
 *
 * `status` distinguishes an authoritative diff from a capability gap so path
 * filters never infer a no-match from an empty list:
 * - `fetched` — the list is authoritative; an empty `files` genuinely means
 *   "no files changed" and does NOT match a path filter.
 * - `unavailable` — the diff could not be determined (e.g. a universal-git PR
 *   event with no per-commit diff in the webhook body). Path filters match
 *   conservatively so a real change is never silently dropped.
 *
 * `skipped` is intentionally NOT a fetcher outcome — it is set by the pipeline
 * when no trigger has path patterns and the fetch never runs.
 */
export interface ChangedFilesResult {
  files: string[];
  status: Extract<ChangedFilesStatus, 'fetched' | 'unavailable'>;
}

export interface ChangedFilesFetcher {
  readonly provider: ProviderType;

  /**
   * Get changed files for a webhook event.
   *
   * For PRs: files changed in the pull/merge request.
   * For pushes: files changed across the pushed commits.
   *
   * @param repoIdentifier - Provider-specific repo identifier (e.g., "owner/repo" for GitHub)
   * @param eventType - Normalized event type ("pull_request" or "push")
   * @param payload - Raw webhook payload (provider-specific)
   * @param credentials - Provider-specific auth credentials
   * @returns The changed file paths (relative to repo root) plus an availability status.
   */
  getChangedFiles(
    repoIdentifier: string,
    eventType: string,
    payload: unknown,
    credentials: unknown,
  ): Promise<ChangedFilesResult>;
}
