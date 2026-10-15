/**
 * Fetches a repository file at a ref via the provider's API, so the
 * orchestrator evaluates content-match triggers without cloning the repo.
 */

import type { ProviderType } from './types.js';

export interface FileContentsFetcher {
  readonly provider: ProviderType;

  /**
   * Fetch the contents of a file in a repository at a specific ref.
   *
   * - `{ present: false }` -- a provider 404, or the path is a directory.
   * - `{ present: true, bytes }` -- the inline content, decoded to a string.
   * - `{ present: true }` (no `bytes`) -- the file exists but the provider
   *   returned no inline content (e.g. GitHub's Contents API above 1 MiB). A
   *   caller MUST NOT read a missing `bytes` as an absent file.
   *
   * Implementations do not cap the content (the orchestrator's content matcher
   * enforces a post-materialization cap) and MUST NOT fall back to a raw blob
   * download to defeat a provider's inline-content size limit.
   *
   * @param owner - Repository owner (e.g. "my-org")
   * @param repo - Repository name (e.g. "my-app")
   * @param path - Repo-relative file path (e.g. ".kici/workflows/ci.ts")
   * @param ref - Git ref (branch name, tag, or SHA)
   */
  getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ present: boolean; bytes?: string }>;
}
