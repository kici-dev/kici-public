/**
 * GitHub file contents fetcher.
 *
 * Implements the FileContentsFetcher interface from @kici-dev/engine for GitHub.
 * Fetches an arbitrary file's contents from a GitHub repository at a specific
 * ref via the Contents API, so the orchestrator can evaluate content-match
 * triggers without cloning the repo.
 */

import type { FileContentsFetcher } from '@kici-dev/engine';
import { createInstallationOctokit, type GitHubAppConfig } from './auth.js';

/**
 * GitHub-specific implementation of FileContentsFetcher.
 *
 * The installation id is baked in at construction because the
 * FileContentsFetcher interface is credential-less at call time -- a fetcher
 * instance is scoped to one GitHub App installation.
 */
export class GitHubFileContentsFetcher implements FileContentsFetcher {
  readonly provider = 'github' as const;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly installationId: number,
  ) {}

  /**
   * Fetch a file's contents from a GitHub repository at a specific ref.
   *
   * @param owner - Repository owner (e.g. "my-org")
   * @param repo - Repository name (e.g. "my-app")
   * @param path - Repo-relative file path (e.g. ".kici/workflows/ci.ts")
   * @param ref - Git ref (branch, tag, or SHA)
   * @returns `{ present: false }` on 404 / directory; `{ present: true, bytes }`
   *          when inline content is returned; `{ present: true }` (no bytes)
   *          when the file exists but GitHub omits inline content (files over
   *          1 MiB).
   */
  async getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ present: boolean; bytes?: string }> {
    const octokit = createInstallationOctokit(this.config, this.installationId);

    let data: { size?: number; content?: string; encoding?: string };
    try {
      // Build the URL manually because Octokit's template expansion URL-encodes
      // the `{path}` parameter, turning `.kici/workflows/ci.ts` into
      // `.kici%2Fworkflows%2Fci.ts` which GitHub's Contents API rejects with a
      // 404. Encode each segment individually so slashes stay literal.
      const url = `GET /repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`;
      const response = await octokit.request(url, { ref });

      // A directory listing is not a file.
      if (Array.isArray(response.data)) {
        return { present: false };
      }

      data = response.data as { size?: number; content?: string; encoding?: string };
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return { present: false };
      }
      throw error;
    }

    // The Contents API returns inline base64 content only for files up to
    // 1 MiB. For larger files (default/object media type) it returns metadata
    // with an empty `content` and `encoding: 'none'`. Surface those as
    // present-without-bytes rather than issuing a raw blob download that would
    // load an unbounded payload into memory -- the 1 MiB match cap lives in the
    // content matcher (post-materialization), and a caller must not read a
    // missing `bytes` as an absent file.
    if (data.encoding !== 'base64' || !data.content) {
      return { present: true };
    }

    // GitHub handed us inline content: decode and return it verbatim. The
    // fetcher imposes no cap of its own.
    const bytes = Buffer.from(data.content, 'base64').toString('utf-8');
    return { present: true, bytes };
  }
}

/**
 * Percent-encode each path segment while keeping the `/` separators literal,
 * so nested paths reach GitHub's Contents API intact.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Check if an error is a GitHub 404 (Not Found) response.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: number }).status === 404
  );
}
