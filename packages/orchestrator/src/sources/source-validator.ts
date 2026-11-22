/**
 * Source credential validator.
 *
 * Validates provider credentials before saving a source configuration.
 * For GitHub, verifies that the appId + privateKey can authenticate
 * as a GitHub App by calling GET /app on the server the App lives on.
 */
import { createAppOctokit, type GitHubAppConfig } from '../providers/github/auth.js';

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
 * Creates a JWT from the appId + privateKey and calls GET /app on the App's
 * server (`app.githubUrl`, github.com when unset) to verify the credentials
 * and retrieve the app name.
 */
export async function validateGitHubSource(app: GitHubAppConfig): Promise<ValidationResult> {
  try {
    const { data } = await createAppOctokit(app).apps.getAuthenticated();
    return { valid: true, appName: data?.name ?? 'Unknown', slug: data?.slug };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `GitHub API validation failed: ${message}` };
  }
}
