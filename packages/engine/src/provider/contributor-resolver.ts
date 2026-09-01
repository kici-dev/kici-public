/**
 * ContributorResolver interface for determining contributor permissions.
 *
 * Deprecated in favour of ref-based trust: the whole interface, including the
 * `ContributorPermission` / `ContributorInfo` shapes it carries, is retained
 * for compatibility and has no caller in this repo.
 */
import type { ProviderType } from './types.js';

/** Contributor's permission level on a repository. */
export type ContributorPermission = 'admin' | 'write' | 'read' | 'none';

/** Information about a contributor and their relationship to a PR. */
export interface ContributorInfo {
  username: string;
  permission: ContributorPermission;
  /** Whether the PR comes from a fork */
  isForkPR: boolean;
}

/**
 * Resolves contributor information from a git hosting provider.
 *
 * @deprecated Trust is derived from the git ref, not from the contributor's
 * permission level, so nothing in the webhook pipeline calls a resolver. The
 * type stays exported for wire compatibility with external implementations and
 * is removed at v1.0.0.
 */
export interface ContributorResolver {
  readonly provider: ProviderType;
  resolveContributor(
    repoIdentifier: string,
    username: string,
    credentials: unknown,
  ): Promise<ContributorInfo>;
}
