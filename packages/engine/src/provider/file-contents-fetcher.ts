/**
 * FileContentsFetcher interface.
 *
 * Fetches the contents of an arbitrary repository file at a specific ref via a
 * provider's repository API. Used by the orchestrator to evaluate content-match
 * triggers without cloning the repo.
 */

import type { ProviderType } from './types.js';

export interface FileContentsFetcher {
  readonly provider: ProviderType;

  /**
   * Fetch the contents of a file in a repository at a specific ref.
   *
   * Result shape:
   * - `{ present: false }` -- the file does not exist (a 404 from the provider,
   *   or the path resolves to a directory rather than a file).
   * - `{ present: true, bytes }` -- the file exists and the provider returned
   *   its inline content, decoded to a string.
   * - `{ present: true }` (no `bytes`) -- the file exists but the provider did
   *   not return inline content (e.g. GitHub's Contents API omits content for
   *   files larger than 1 MiB). A caller MUST NOT read a missing `bytes` as an
   *   absent file.
   *
   * Implementations do not cap the returned content -- any size limit is the
   * caller's concern (the orchestrator's content matcher enforces a
   * post-materialization cap). Implementations MUST NOT fall back to a raw
   * blob download to defeat a provider's inline-content size limit.
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
