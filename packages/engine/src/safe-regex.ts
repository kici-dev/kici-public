import safeRegex from 'safe-regex';

/**
 * Reject a ReDoS-prone author-supplied regex before it is compiled.
 *
 * `safe-regex` is a star-height heuristic. The orchestrator is single-tenant, so
 * a slipped-through pattern only stalls the author's own orchestrator, but every
 * author regex compiled from lock-file data on the webhook path (label selectors,
 * branch/tag/repo patterns, embedded JSONPath `/re/flags`, comment `bodyMatch`)
 * must pass here so a catastrophic pattern fails at compile/registration time.
 * Globs are linear by construction but pass through for uniformity.
 *
 * `ctx` (e.g. "branch pattern", "job 'web' runsOn") names the pattern in the error.
 */
export function assertSafeRegex(source: string, flags: string, ctx: string): void {
  if (!safeRegex(new RegExp(source, flags))) {
    throw new Error(`${ctx}: regex /${source}/${flags} is ReDoS-prone — rejected`);
  }
}
