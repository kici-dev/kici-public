/**
 * GitHub changed files fetcher.
 *
 * Implements the ChangedFilesFetcher interface from @kici-dev/engine for GitHub.
 * Retrieves changed files for PR and push events via the GitHub API.
 */

import type { ChangedFilesFetcher } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'github:changed-files' });
import { createInstallationOctokit, type GitHubAppConfig, type GitHubCredentials } from './auth.js';

/** All-zero SHA indicating an initial push (branch creation) */
const ZERO_SHA = '0000000000000000000000000000000000000000';

/** GitHub's maximum files returned by compareCommits */
const GITHUB_COMPARE_FILE_LIMIT = 300;

/** Maximum retries for 429 (rate limit) responses */
const MAX_429_RETRIES = 3;

/** Base delay in ms for exponential backoff on 429 */
const BASE_BACKOFF_MS = 1_000;

/**
 * Check if an error is a GitHub 429 rate limit response.
 * Octokit throws RequestError with a numeric `status` property.
 */
export function isRateLimitError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status: unknown }).status === 429
  );
}

/**
 * Execute a function with retry on 429 rate limit errors.
 * Uses exponential backoff: 1s, 2s, 4s.
 * Non-429 errors are rethrown immediately.
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt === MAX_429_RETRIES) {
        throw err;
      }
      const delayMs = BASE_BACKOFF_MS * 2 ** attempt;
      logger.warn('GitHub API rate limited (429), retrying with backoff', {
        context,
        attempt: attempt + 1,
        maxRetries: MAX_429_RETRIES,
        delayMs,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Unreachable — the loop either returns or throws
  throw new Error('Unreachable');
}

/**
 * Minimal webhook payload shape for extracting repository info and event-specific data.
 * These types cover the fields we actually use, not the full GitHub webhook payload.
 */
interface WebhookPayload {
  repository: {
    owner: { login: string };
    name: string;
  };
  /** Present on pull_request events */
  pull_request?: {
    number: number;
  };
  /** Present on push events */
  before?: string;
  after?: string;
}

/**
 * GitHub-specific implementation of ChangedFilesFetcher.
 *
 * For PRs: uses paginated pulls.listFiles API (handles up to 3000 files).
 * For pushes: uses repos.compareCommits API (logs warning at 300+ files).
 * For initial pushes (zero SHA): returns empty array.
 * For unknown events: returns empty array.
 */
export class GitHubChangedFilesFetcher implements ChangedFilesFetcher {
  readonly provider = 'github' as const;

  constructor(private readonly config: GitHubAppConfig) {}

  /**
   * Get changed files for a GitHub webhook event.
   *
   * @param repoIdentifier - "owner/repo" format
   * @param eventType - GitHub event type ("pull_request" or "push")
   * @param payload - Raw GitHub webhook payload
   * @param credentials - Must be GitHubCredentials with installationId
   * @returns Array of changed file paths
   */
  async getChangedFiles(
    repoIdentifier: string,
    eventType: string,
    payload: unknown,
    credentials: unknown,
  ): Promise<string[]> {
    const { installationId } = credentials as GitHubCredentials;
    const [owner, repo] = repoIdentifier.split('/');
    const p = payload as WebhookPayload;

    const octokit = createInstallationOctokit(this.config, installationId);

    if (eventType === 'pull_request') {
      return this.getPrChangedFiles(octokit, owner, repo, p);
    }

    if (eventType === 'push') {
      return this.getPushChangedFiles(octokit, owner, repo, p);
    }

    logger.debug('Unknown event type for changed files, returning empty', { event: eventType });
    return [];
  }

  /**
   * Get changed files for a pull request event using paginated listFiles API.
   */
  private async getPrChangedFiles(
    octokit: ReturnType<typeof createInstallationOctokit>,
    owner: string,
    repo: string,
    payload: WebhookPayload,
  ): Promise<string[]> {
    if (!payload.pull_request) {
      logger.warn('pull_request event missing pull_request data', { owner, repo });
      return [];
    }

    const pullNumber = payload.pull_request.number;

    const files = await withRateLimitRetry(
      () =>
        octokit.paginate(octokit.rest.pulls.listFiles, {
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        }),
      `pulls.listFiles(${owner}/${repo}#${pullNumber})`,
    );

    return files.map((file) => file.filename);
  }

  /**
   * Get changed files for a push event using compareCommits API.
   */
  private async getPushChangedFiles(
    octokit: ReturnType<typeof createInstallationOctokit>,
    owner: string,
    repo: string,
    payload: WebhookPayload,
  ): Promise<string[]> {
    const before = payload.before;
    const after = payload.after;

    if (!before || !after) {
      logger.warn('push event missing before/after SHAs', { owner, repo });
      return [];
    }

    // Initial push (branch creation) has all-zero before SHA
    if (before === ZERO_SHA) {
      logger.debug('Initial push detected (zero SHA), returning empty changed files', {
        owner,
        repo,
        after,
      });
      return [];
    }

    // Branch deletion has all-zero after SHA
    if (after === ZERO_SHA) {
      logger.debug('Branch deletion detected (zero after SHA), returning empty changed files', {
        owner,
        repo,
        before,
      });
      return [];
    }

    const response = await withRateLimitRetry(
      () =>
        octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: before,
          head: after,
        }),
      `repos.compareCommits(${owner}/${repo}, ${before.slice(0, 7)}..${after.slice(0, 7)})`,
    );

    const files = response.data.files ?? [];

    if (files.length >= GITHUB_COMPARE_FILE_LIMIT) {
      logger.warn(
        `Push event has ${files.length} changed files (>= ${GITHUB_COMPARE_FILE_LIMIT}), results may be truncated by GitHub`,
        { owner, repo, before, after, fileCount: files.length },
      );
    }

    return files.map((file) => file.filename);
  }
}
