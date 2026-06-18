/**
 * GitHub ContributorResolver implementation.
 *
 * Resolves contributor permissions by querying the GitHub API for
 * collaborator permission levels on a repository.
 */

import { createLogger } from '@kici-dev/shared';
import type { ContributorResolver, ContributorInfo, ContributorPermission } from '@kici-dev/engine';
import { createInstallationOctokit, type GitHubAppConfig, type GitHubCredentials } from './auth.js';

const logger = createLogger({ prefix: 'github:contributor-resolver' });

/**
 * Map GitHub permission level strings to KiCI ContributorPermission.
 *
 * GitHub returns: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'
 * KiCI uses: 'admin' | 'write' | 'read' | 'none'
 */
function mapGitHubPermission(githubPermission: string): ContributorPermission {
  switch (githubPermission) {
    case 'admin':
      return 'admin';
    case 'maintain':
    case 'write':
      return 'write';
    case 'triage':
    case 'read':
      return 'read';
    default:
      return 'none';
  }
}

/**
 * GitHub-specific implementation of ContributorResolver.
 *
 * Uses the GitHub API to check a user's permission level on a repository.
 * Handles 403 (insufficient app permissions) and 404 (not a collaborator)
 * gracefully by returning 'none' permission.
 */
export class GitHubContributorResolver implements ContributorResolver {
  readonly provider = 'github' as const;

  constructor(private readonly config: GitHubAppConfig) {}

  /**
   * Resolve a contributor's permission level on a GitHub repository.
   *
   * @param repoIdentifier - "owner/repo" format
   * @param username - GitHub username
   * @param credentials - GitHubCredentials with installationId
   * @returns ContributorInfo with mapped permission level
   */
  async resolveContributor(
    repoIdentifier: string,
    username: string,
    credentials: unknown,
  ): Promise<ContributorInfo> {
    const { installationId } = credentials as GitHubCredentials;
    const [owner, repo] = repoIdentifier.split('/');

    const octokit = createInstallationOctokit(this.config, installationId);

    try {
      const { data } = await octokit.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      });

      const permission = mapGitHubPermission(data.permission);
      logger.debug('Resolved contributor permission', { username, repoIdentifier, permission });

      return {
        username,
        permission,
        isForkPR: false, // Caller (TrustResolver) sets this from webhook data
      };
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;

      if (status === 403) {
        logger.warn('GitHub App lacks permission to check collaborator level', {
          username,
          repoIdentifier,
        });
        return { username, permission: 'none', isForkPR: false };
      }

      if (status === 404) {
        logger.debug('User is not a collaborator', { username, repoIdentifier });
        return { username, permission: 'none', isForkPR: false };
      }

      // Unexpected error — rethrow
      throw error;
    }
  }
}
