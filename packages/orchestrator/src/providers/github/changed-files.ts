/**
 * GitHub changed files fetcher.
 *
 * Implements the ChangedFilesFetcher interface from @kici-dev/engine for GitHub.
 * Retrieves changed files for PR and push events via the GitHub API.
 */

import type { ChangedFilesFetcher, ChangedFilesResult } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'github:changed-files' });
import { createInstallationOctokit, type GitHubAppConfig, type GitHubCredentials } from './auth.js';

/** All-zero SHA indicating an initial push (branch creation) */
const ZERO_SHA = '0000000000000000000000000000000000000000';

/** GitHub's maximum files returned by compareCommits */
const GITHUB_COMPARE_FILE_LIMIT = 300;

/** GitHub's maximum files returned by pulls.listFiles */
const GITHUB_PR_FILE_LIMIT = 3000;

/** Maximum retries for 429 (rate limit) responses */
const MAX_429_RETRIES = 3;

/** Maximum retries for transient 5xx server errors */
const MAX_5XX_RETRIES = 2;

/** Base delay in ms for exponential backoff */
const BASE_BACKOFF_MS = 1_000;

/** Prefix on the propagated error so degraded trigger evaluation is greppable. */
const DEGRADED_FETCH_MESSAGE = 'changed-files fetch failed — trigger evaluation degraded';

/** Read a numeric `status` off an Octokit RequestError, if present. */
function errorStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * Check if an error is a GitHub 429 rate limit response.
 * Octokit throws RequestError with a numeric `status` property.
 */
export function isRateLimitError(err: unknown): boolean {
  return errorStatus(err) === 429;
}

/**
 * Check if an error is a transient GitHub 5xx server error worth retrying.
 * A pure network error (no numeric `status`) is deliberately NOT transient
 * here — it rethrows immediately (loud) rather than masking a persistent
 * connectivity fault behind silent retries.
 */
export function isTransientServerError(err: unknown): boolean {
  const status = errorStatus(err);
  return status !== undefined && status >= 500;
}

/**
 * Execute a function with bounded retry on 429 rate-limit AND 5xx server
 * errors, each with its own budget and exponential backoff (1s, 2s, …).
 * Every other error — a 4xx, or a network error with no `status` — is
 * rethrown immediately (loud; not retried).
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
  let rateLimitRetries = 0;
  let serverErrorRetries = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err) && rateLimitRetries < MAX_429_RETRIES) {
        const delayMs = BASE_BACKOFF_MS * 2 ** rateLimitRetries;
        rateLimitRetries++;
        logger.warn('GitHub API rate limited (429), retrying with backoff', {
          context,
          attempt: rateLimitRetries,
          maxRetries: MAX_429_RETRIES,
          delayMs,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (isTransientServerError(err) && serverErrorRetries < MAX_5XX_RETRIES) {
        const delayMs = BASE_BACKOFF_MS * 2 ** serverErrorRetries;
        serverErrorRetries++;
        logger.warn('GitHub API server error (5xx), retrying with backoff', {
          context,
          attempt: serverErrorRetries,
          maxRetries: MAX_5XX_RETRIES,
          delayMs,
        });
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Minimal webhook payload shape for extracting repository info and event-specific data.
 * These types cover the fields we actually use, not the full GitHub webhook payload.
 */
interface WebhookPayload {
  repository: {
    owner: { login: string };
    name: string;
    default_branch?: string;
  };
  /** Present on push events: the pushed ref (`refs/heads/<branch>`). */
  ref?: string;
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
 * For PRs: uses the paginated pulls.listFiles API; a result at GitHub's
 * 3000-file cap is truncated, so it reports `unavailable`.
 * For pushes: uses the repos.compareCommits API; a result at GitHub's 300-file
 * cap is truncated, so it reports `unavailable`.
 * For a new branch (zero `before`): compares the default branch against
 * `after` (three-dot), the files the branch adds. With no known default
 * branch, or the default branch itself being created, it reports `unavailable`.
 * For a deleted branch (zero `after`): `fetched` + [].
 * For unknown events: reports `unavailable`.
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
  ): Promise<ChangedFilesResult> {
    const { installationId } = credentials as GitHubCredentials;
    const [owner, repo] = repoIdentifier.split('/');
    const p = payload as WebhookPayload;

    const octokit = createInstallationOctokit(this.config, installationId);

    try {
      if (eventType === 'pull_request') {
        return await this.getPrChangedFiles(octokit, owner, repo, p);
      }

      if (eventType === 'push') {
        return await this.getPushChangedFiles(octokit, owner, repo, p);
      }

      // Unknown event type: we cannot determine a diff. Report `unavailable`
      // (not `fetched` + []) so a path-filtered workflow matches conservatively
      // rather than silently dropping.
      logger.warn('Unknown event type for changed files, reporting unavailable', {
        event: eventType,
      });
      return { files: [], status: 'unavailable' };
    } catch (err) {
      // A real API failure (exhausted 429/5xx retries, or an un-retried 4xx /
      // network error) propagates loudly with a distinct, greppable prefix so
      // the event-log `failed` row and operators can see WHY evaluation could
      // not run — never a silent no-match.
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(`${DEGRADED_FETCH_MESSAGE}: ${original}`, { cause: err });
    }
  }

  /**
   * Get changed files for a pull request event using paginated listFiles API.
   */
  private async getPrChangedFiles(
    octokit: ReturnType<typeof createInstallationOctokit>,
    owner: string,
    repo: string,
    payload: WebhookPayload,
  ): Promise<ChangedFilesResult> {
    if (!payload.pull_request) {
      logger.warn('pull_request event missing pull_request data, reporting unavailable', {
        owner,
        repo,
      });
      return { files: [], status: 'unavailable' };
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

    if (files.length >= GITHUB_PR_FILE_LIMIT) {
      logger.warn(
        `Pull request listFiles returned ${files.length} files (>= ${GITHUB_PR_FILE_LIMIT}); GitHub truncates here, so the list is not authoritative`,
        { owner, repo, pullNumber, fileCount: files.length },
      );
      return { files: [], status: 'unavailable' };
    }

    return { files: files.map((file) => file.filename), status: 'fetched' };
  }

  /**
   * Get changed files for a push event using compareCommits API.
   */
  private async getPushChangedFiles(
    octokit: ReturnType<typeof createInstallationOctokit>,
    owner: string,
    repo: string,
    payload: WebhookPayload,
  ): Promise<ChangedFilesResult> {
    const before = payload.before;
    const after = payload.after;

    if (!before || !after) {
      logger.warn('push event missing before/after SHAs, reporting unavailable', { owner, repo });
      return { files: [], status: 'unavailable' };
    }

    // Branch deletion has all-zero after SHA — a genuine no-diff.
    if (after === ZERO_SHA) {
      logger.debug('Branch deletion detected (zero after SHA), returning empty changed files', {
        owner,
        repo,
        before,
      });
      return { files: [], status: 'fetched' };
    }

    // A new branch: the files it adds relative to the default branch (GitHub's
    // compare is three-dot). A created tag, an unknown default, or the default
    // branch itself being created leaves no range.
    if (before === ZERO_SHA) {
      const defaultBranch = payload.repository.default_branch;
      const isBranchRef = payload.ref === undefined || payload.ref.startsWith('refs/heads/');
      const pushed = payload.ref?.slice('refs/heads/'.length);
      if (!isBranchRef || !defaultBranch || defaultBranch === pushed) {
        logger.debug('New-branch push with no other default branch to diff against', {
          owner,
          repo,
          after,
        });
        return { files: [], status: 'unavailable' };
      }
      return this.compare(octokit, owner, repo, defaultBranch, after);
    }

    return this.compare(octokit, owner, repo, before, after);
  }

  /**
   * Compare two refs through the compareCommits API. A result at GitHub's
   * 300-file cap is truncated, so it reports `unavailable`.
   */
  private async compare(
    octokit: ReturnType<typeof createInstallationOctokit>,
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<ChangedFilesResult> {
    const response = await withRateLimitRetry(
      () => octokit.rest.repos.compareCommits({ owner, repo, base, head }),
      `repos.compareCommits(${owner}/${repo}, ${base.slice(0, 7)}..${head.slice(0, 7)})`,
    );

    const files = response.data.files ?? [];

    if (files.length >= GITHUB_COMPARE_FILE_LIMIT) {
      logger.warn(
        `Push compare returned ${files.length} files (>= ${GITHUB_COMPARE_FILE_LIMIT}); GitHub truncates here, so the list is not authoritative`,
        { owner, repo, base, head, fileCount: files.length },
      );
      return { files: [], status: 'unavailable' };
    }

    return { files: files.map((file) => file.filename), status: 'fetched' };
  }
}
