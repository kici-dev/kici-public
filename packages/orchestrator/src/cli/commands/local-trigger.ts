/**
 * Build and send the synthetic webhook that triggers a run against a local
 * filesystem (`file://`) source. The orchestrator's provider-agnostic generic
 * webhook route (`POST /webhook/:orgId/generic/:sourceId`) dispatches it through
 * the local provider's normalizer. Shared by the `source trigger-local` CLI
 * command and the generated `post-receive` hook.
 *
 * A local repo has no remote forge to send webhooks, so this is the operator's
 * way to drive a run: either by hand (`trigger-local`) or on every push via an
 * installed `post-receive` hook (`install-hook`).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface LocalTriggerInput {
  orgId: string;
  sourceId: string;
  repoFullName: string;
  event: 'push' | 'pull_request';
  ref: string;
  sha: string;
  /**
   * The commit before the push. With it the changed files are `before..sha`;
   * without it the push has no range and path filters match conservatively.
   */
  before?: string;
  defaultBranch: string;
}

export interface LocalTriggerRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Build the GitHub-shaped webhook request the local provider normalizer expects. */
export function buildLocalTriggerRequest(input: LocalTriggerInput): LocalTriggerRequest {
  const body = JSON.stringify({
    ref: input.ref,
    ...(input.before && { before: input.before }),
    after: input.sha,
    repository: { full_name: input.repoFullName, default_branch: input.defaultBranch },
  });
  return {
    path: `/webhook/${input.orgId}/generic/${input.sourceId}`,
    headers: {
      'content-type': 'application/json',
      'x-event-type': input.event,
      'x-delivery-id': randomUUID(),
    },
    body,
  };
}

/** Read HEAD ref + sha from a local git repo (used when the operator omits --ref/--sha). */
export function readRepoHead(repoPath: string): { ref: string; sha: string } {
  const sha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const branch = execFileSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { ref: `refs/heads/${branch}`, sha };
}

/** The parent of `sha` in a local repo, or undefined for a root commit or an unreadable repo. */
export function readParentSha(repoPath: string, sha: string): string | undefined {
  try {
    const parent = execFileSync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${sha}^`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return parent || undefined;
  } catch {
    return undefined;
  }
}

/** POST the trigger request to the orchestrator base URL. Returns the HTTP status. */
export async function sendLocalTrigger(baseUrl: string, req: LocalTriggerRequest): Promise<number> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${req.path}`, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
  });
  return res.status;
}
