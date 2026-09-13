/**
 * Universal-git repository URL builder.
 *
 * Implements the `RepoUrlBuilder` interface from `@kici-dev/engine`. Each
 * universal-git source provides a `gitUrlTemplate` (e.g.
 * `https://forgejo.example.com/{owner}/{name}.git` or
 * `ssh://git@forgejo.example.com/{owner}/{name}.git`) plus a `repoIdentifier`
 * that appears in the normalized webhook (typically `owner/name`). This class
 * substitutes `{owner}`, `{name}`, and `{repo}` placeholders to build the
 * concrete clone URL used by agents.
 */

import type { RepoUrlBuilder } from '@kici-dev/engine';

/** Placeholder keys supported in `gitUrlTemplate`. */
const PLACEHOLDER_OWNER = '{owner}';
const PLACEHOLDER_NAME = '{name}';
const PLACEHOLDER_REPO = '{repo}';

/**
 * Universal-git implementation of RepoUrlBuilder.
 *
 * Bound to a single source's URL template — the orchestrator constructs one
 * per registered universal-git source.
 */
export class UniversalGitRepoUrlBuilder implements RepoUrlBuilder {
  readonly provider = 'generic' as const;

  constructor(private readonly gitUrlTemplate: string) {
    if (!gitUrlTemplate || gitUrlTemplate.trim() === '') {
      throw new Error('UniversalGitRepoUrlBuilder requires a non-empty gitUrlTemplate');
    }
  }

  /**
   * Build the clone URL by substituting placeholders in the template with
   * values from the repo identifier (expected as `owner/name`).
   *
   * Accepts identifiers with a single slash (`owner/name`) or with multiple
   * segments (GitLab groups: `group/subgroup/project`); the trailing segment
   * is always treated as the repo name and everything before it as the
   * owner path.
   */
  buildCloneUrl(repoIdentifier: string): string {
    const { owner, name } = splitRepoIdentifier(repoIdentifier);
    return this.gitUrlTemplate
      .split(PLACEHOLDER_OWNER)
      .join(owner)
      .split(PLACEHOLDER_NAME)
      .join(name)
      .split(PLACEHOLDER_REPO)
      .join(repoIdentifier);
  }

  /**
   * Raw file URLs are not supported for universal-git sources — the agent
   * always shallow-clones the repo to fetch files. Returning the clone URL
   * keeps the interface contract honest; callers that need raw content must
   * use the shallow-clone path instead.
   */
  buildRawFileUrl(repoIdentifier: string, _ref: string, _path: string): string {
    return this.buildCloneUrl(repoIdentifier);
  }
}

/**
 * Split `owner/name` or `group/subgroup/project` into the owner path plus
 * the final repo name. Throws on malformed input so misconfigured sources
 * fail loudly rather than producing broken clone URLs.
 */
export function splitRepoIdentifier(repoIdentifier: string): { owner: string; name: string } {
  const trimmed = repoIdentifier.trim();
  if (!trimmed.includes('/')) {
    throw new Error(
      `Universal-git repoIdentifier must contain at least one "/" separator, got: ${repoIdentifier}`,
    );
  }
  const idx = trimmed.lastIndexOf('/');
  const owner = trimmed.slice(0, idx);
  const name = trimmed.slice(idx + 1);
  if (!owner || !name) {
    throw new Error(`Invalid repoIdentifier (empty owner or name segment): ${repoIdentifier}`);
  }
  return { owner, name };
}
