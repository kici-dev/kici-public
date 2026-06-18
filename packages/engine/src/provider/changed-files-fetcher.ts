/**
 * ChangedFilesFetcher interface.
 *
 * Retrieves the list of files changed in a webhook event from the provider's API.
 * Used by the orchestrator for path-based trigger filtering.
 */

import type { ProviderType } from './types.js';

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
   * @returns Array of changed file paths (relative to repo root)
   */
  getChangedFiles(
    repoIdentifier: string,
    eventType: string,
    payload: unknown,
    credentials: unknown,
  ): Promise<string[]>;
}
