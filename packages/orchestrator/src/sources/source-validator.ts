/**
 * Source credential validator.
 *
 * Validates provider credentials before saving a source configuration.
 * For GitHub, verifies that the appId + privateKey can authenticate
 * as a GitHub App by calling GET /app.
 */
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

/**
 * Result of a source credential validation.
 */
export interface ValidationResult {
  valid: boolean;
  appName?: string;
  /** GitHub App slug (URL-safe identifier) returned by `GET /app`. */
  slug?: string;
  error?: string;
}

/**
 * Validate GitHub App credentials by calling the GitHub API.
 *
 * Creates a JWT from the appId + privateKey and calls GET /app
 * to verify the credentials are valid and retrieve the app name.
 */
export async function validateGitHubSource(
  appId: string,
  privateKey: string,
): Promise<ValidationResult> {
  try {
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey },
    });
    const { data } = await octokit.apps.getAuthenticated();
    return { valid: true, appName: data?.name ?? 'Unknown', slug: data?.slug };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `GitHub API validation failed: ${message}` };
  }
}
