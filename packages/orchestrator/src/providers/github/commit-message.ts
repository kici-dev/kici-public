/**
 * Where the commit message lives in a GitHub webhook payload, and the two
 * different readings of it.
 *
 * They differ deliberately. `githubFilterText` feeds the Tier-0 `commitMessage`
 * trigger filter, so it must be the WHOLE message — truncating to the subject
 * line would make a `[skip ci]` marker written in the body invisible to a filter
 * that names it. `githubDisplayMessage` feeds run-display metadata, where a
 * one-line summary is the point.
 */

/** Full text a `commitMessage` trigger filter is tested against; undefined when the payload carries none. */
export function githubFilterText(event: string, payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;

  if (event === 'push') {
    const headCommit = p.head_commit as { message?: unknown } | null | undefined;
    return typeof headCommit?.message === 'string' ? headCommit.message : undefined;
  }

  if (
    event === 'pull_request' ||
    event === 'pull_request_review' ||
    event === 'pull_request_review_comment'
  ) {
    const pr = p.pull_request as { title?: unknown; body?: unknown } | null | undefined;
    if (pr === null || pr === undefined || typeof pr.title !== 'string') return undefined;
    const title = pr.title;
    const body = typeof pr.body === 'string' && pr.body.length > 0 ? pr.body : undefined;
    return body === undefined ? title : `${title}\n${body}`;
  }

  return undefined;
}

/**
 * One-line message for run display: the subject (first line) of a push's
 * head-commit message, the PR title, or the issue title. This is the reading
 * run-display metadata uses, distinct from the full text `githubFilterText`
 * feeds the Tier-0 filter.
 */
export function githubDisplayMessage(event: string, payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;

  if (event === 'push') {
    const headCommit = p.head_commit as { message?: unknown } | null | undefined;
    if (typeof headCommit?.message === 'string' && headCommit.message.length > 0) {
      return headCommit.message.split('\n')[0];
    }
    return undefined;
  }

  if (
    event === 'pull_request' ||
    event === 'pull_request_review' ||
    event === 'pull_request_review_comment'
  ) {
    const pr = p.pull_request as { title?: unknown } | undefined;
    return typeof pr?.title === 'string' && pr.title.length > 0 ? pr.title : undefined;
  }

  if (event === 'issue_comment') {
    const issue = p.issue as { title?: unknown } | undefined;
    return typeof issue?.title === 'string' && issue.title.length > 0 ? issue.title : undefined;
  }

  return undefined;
}
