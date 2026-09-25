/**
 * The dispatch-time warning for a job context that has no scope binding.
 *
 * A job receives a context's secrets only through the context's scope
 * bindings, so a context with none delivers no secret, and nothing fails until
 * a step reads one. This names each such context in the orchestrator log when
 * the job's context data resolves. Advisory only: it runs after resolution, a
 * failed lookup logs nothing, and the dispatch proceeds unchanged.
 */
import type { Context } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';

const logger = createLogger({ prefix: 'job-contexts' });

/** The warning line's message; the structured fields carry the identities. */
export const UNBOUND_JOB_CONTEXT_MESSAGE =
  'Job binds a context that has no scope binding; it receives no secrets from it';

/**
 * Warn once for every context in `entries` that resolved no secret and has no
 * scope binding. A context that resolved at least one secret is skipped without
 * a lookup, so a bound context costs nothing here.
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
      // The resolution this follows already succeeded; a failed count leaves
      // nothing to warn about and must not fail the job's dispatch.
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
