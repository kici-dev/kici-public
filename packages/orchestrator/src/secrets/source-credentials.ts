/**
 * Source-scoped credential resolution.
 *
 * Generic/universal-git webhook sources store a `credentialRef` (see
 * `providers/universal-git/config.ts`) that points to a secret the agent
 * will use to clone the source's repo. The secret itself is stored under
 * the reserved scope `__source__/<sourceId>` — the same convention already
 * used by `PgSecretStore.isInternalScope()` — with `credentialRef.key` as
 * the key name.
 *
 * This module is a thin, opinionated wrapper around
 * `SecretResolver.resolveNamed()` that:
 *   1. Builds the canonical scope string for a given source ID.
 *   2. Delegates to the resolver's direct-lookup method.
 *   3. Returns a structured failure (null + reason) so callers can emit
 *      metrics without throwing across the clone-token boundary.
 *
 * The universal-git provider bundle's `CloneTokenProvider` is the primary
 * consumer; an agent-side secret store lookup is **not** implemented here
 * because the agent never talks to the orchestrator's secret backend
 * directly — the orchestrator resolves and passes the material in the
 * dispatch message (`gitAuth` / `sourceAuth` / `workflowAuth`).
 */

import type { SecretResolver } from './secret-resolver.js';
import type { CredentialRef } from '../providers/universal-git/config.js';

/**
 * Canonical scope for a source-owned secret. Uses the `__source__/` prefix
 * which is whitelisted by `PgSecretStore.isInternalScope()` so setting
 * these secrets is allowed even when customer secrets are globally
 * disabled.
 */
export function sourceCredentialScope(sourceId: string): string {
  if (!sourceId) {
    throw new Error('sourceId is required to build source credential scope');
  }
  return `__source__/${sourceId}`;
}

/**
 * Result of a source credential lookup. `ok: false` is a recoverable
 * miss (secret not present in any backend, or explicit backend empty) —
 * callers can emit metrics or fall through. Throws are reserved for
 * genuine errors (missing backend when one was explicitly requested).
 */
export type SourceCredentialResult =
  | { ok: true; value: string; backend: string }
  | { ok: false; reason: 'not_found' | 'store_missing'; message: string };

/**
 * Resolve a source-scoped credential via the shared SecretResolver.
 *
 * @param resolver      The orchestrator's SecretResolver instance.
 * @param orgId         Organisation/customer ID that owns the source.
 * @param sourceId      Source row ID (`generic_webhook_sources.id`).
 * @param credentialRef The `{ key, store? }` ref validated by Zod.
 * @param opts          Optional correlation IDs for audit entries.
 */
export async function resolveSourceCredential(
  resolver: SecretResolver,
  orgId: string,
  sourceId: string,
  credentialRef: CredentialRef,
  opts?: { runId?: string; jobId?: string },
): Promise<SourceCredentialResult> {
  const scope = sourceCredentialScope(sourceId);
  try {
    const value = await resolver.resolveNamed(orgId, scope, credentialRef.key, {
      store: credentialRef.store,
      runId: opts?.runId,
      jobId: opts?.jobId,
    });
    if (value === null) {
      return {
        ok: false,
        reason: 'not_found',
        message: `Source credential not found: scope=${scope} key=${credentialRef.key}${
          credentialRef.store ? ` store=${credentialRef.store}` : ''
        }`,
      };
    }
    return { ok: true, value, backend: credentialRef.store ?? 'pg' };
  } catch (err) {
    // Only missing explicit backend throws from resolveNamed; translate
    // it into a structured failure so callers don't need try/catch.
    const message = err instanceof Error ? err.message : String(err);
    if (credentialRef.store && message.includes('not registered')) {
      return { ok: false, reason: 'store_missing', message };
    }
    throw err;
  }
}
