/**
 * ContributorResolver interface for determining contributor permissions.
 *
 * Used by the CI security system to check a contributor's permission level
 * on a repository, enabling trust-tier decisions for PR execution gating.
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

/** Resolves contributor information from a git hosting provider. */
export interface ContributorResolver {
  readonly provider: ProviderType;
  resolveContributor(
    repoIdentifier: string,
    username: string,
    credentials: unknown,
  ): Promise<ContributorInfo>;
}
