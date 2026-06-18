/**
 * GitHub clone token provider and authentication utilities.
 *
 * Implements the CloneTokenProvider interface from @kici-dev/engine for GitHub.
 * Uses GitHub App installation tokens for repository access.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { CloneTokenProvider } from '@kici-dev/engine';

/**
 * Configuration required for GitHub App authentication.
 */
export interface GitHubAppConfig {
  /** GitHub App ID (numeric string) */
  appId: string;
  /** GitHub App private key (PEM format) */
  privateKey: string;
}

/**
 * Credentials for GitHub operations requiring installation-level access.
 */
export interface GitHubCredentials {
  installationId: number;
}

/**
 * Create an Octokit instance authenticated as a GitHub App installation.
 *
 * Uses @octokit/auth-app to handle:
 * - JWT generation for app-level authentication
 * - Installation token creation and automatic refresh
 *
 * Each call creates a new Octokit instance scoped to the specific installation.
 * The auth-app strategy handles token caching internally per Octokit instance.
 *
 * @param config - GitHub App credentials (appId + privateKey)
 * @param installationId - GitHub App installation ID for the target account/org
 * @returns Octokit instance with auto-refreshing installation tokens
 */
export function createInstallationOctokit(
  config: GitHubAppConfig,
  installationId: number,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId,
    },
  });
}

/**
 * GitHub-specific implementation of CloneTokenProvider.
 *
 * Creates short-lived installation access tokens for agent repo clone operations.
 * Uses the GitHub App credentials to generate tokens scoped to a specific installation.
 */
export class GitHubCloneTokenProvider implements CloneTokenProvider {
  readonly provider = 'github' as const;

  constructor(private readonly config: GitHubAppConfig) {}

  /** Get the GitHub App config for this provider instance. */
  getAppConfig(): GitHubAppConfig {
    return this.config;
  }

  /**
   * Create a short-lived installation access token for cloning a repo.
   *
   * @param _repoIdentifier - "owner/repo" format (not used for GitHub token creation)
   * @param credentials - Must be GitHubCredentials with installationId
   * @returns Installation access token string
   */
  async createCloneToken(_repoIdentifier: string, credentials: unknown): Promise<string | null> {
    const { installationId } = credentials as GitHubCredentials;
    const octokit = createInstallationOctokit(this.config, installationId);
    const auth = (await octokit.auth({ type: 'installation' })) as { token: string };
    return auth.token;
  }
}
