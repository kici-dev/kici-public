/**
 * The dispatch-time warning for a job context with no scope binding.
 *
 * Secrets reach a job only through scope bindings, so an unbound context
 * delivers none and nothing fails until a step reads one. Advisory only: it runs
 * after resolution, a failed lookup logs nothing, and dispatch is unchanged.
 */
import type { Context } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';

const logger = createLogger({ prefix: 'job-contexts' });

/** The warning line's message; the structured fields carry the identities. */
export const UNBOUND_JOB_CONTEXT_MESSAGE =
  'Job binds a context that has no scope binding; it receives no secrets from it';

/**
 * Warn once per context that resolved no secret and has no scope binding; one
 * that resolved a secret is skipped without a lookup.
 */
export async function warnUnboundJobContexts(args: {
  secretResolver: SecretResolverApi | undefined;
  orgId: string;
  entries: ReadonlyArray<{ name: string; env: Context }>;
  /** Per-context resolved secrets, keyed by the declared name; empty maps are absent. */
  resolvedByName: Readonly<Record<string, Record<string, string>>> | undefined;
  log: { runId: string; workflow: string; job: string };
}): Promise<void> {
  const { secretResolver, orgId, entries, resolvedByName, log } = args;
  const countBindings = secretResolver?.countContextBindings?.bind(secretResolver);
  if (!countBindings) return;
  const checked = new Set<string>();
  for (const { name, env } of entries) {
    if (resolvedByName?.[name] || checked.has(env.id)) continue;
    checked.add(env.id);
    let bindings: number;
    try {
      bindings = await countBindings(env.id);
    } catch {
      // Advisory: a failed count must not fail the dispatch.
      continue;
    }
    // fails-when: a job context with zero bindings dispatches with no log line
    // breaks-if-wrong: a context with a binding that resolves nothing (host-gated) stays silent
    if (bindings === 0) {
      logger.warn(UNBOUND_JOB_CONTEXT_MESSAGE, {
        orgId,
        context: name,
        contextId: env.id,
        runId: log.runId,
        workflow: log.workflow,
        job: log.job,
      });
    }
  }
}
