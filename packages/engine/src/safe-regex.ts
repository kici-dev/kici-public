import safeRegex from 'safe-regex';

/**
 * Reject a ReDoS-prone author-supplied regex before it is compiled.
 *
 * `safe-regex` is a star-height heuristic. The orchestrator is single-tenant, so
 * a slipped-through pattern only stalls the author's own orchestrator — but every
 * author regex the orchestrator compiles from lock-file data on the webhook path
 * (label selectors, branch/tag/repo patterns, embedded JSONPath `/re/flags`,
 * comment `bodyMatch`) must be checked so a catastrophic pattern is rejected at
 * compile/registration time rather than silently compiled. Globs are linear by
 * construction but pass through here for uniformity.
 *
 * `ctx` is a human label (e.g. "branch pattern", "job 'web' runsOn") woven into
 * the thrown error so an operator can identify the offending pattern.
 */
export function assertSafeRegex(source: string, flags: string, ctx: string): void {
  if (!safeRegex(new RegExp(source, flags))) {
    throw new Error(`${ctx}: regex /${source}/${flags} is ReDoS-prone — rejected`);
  }
}
