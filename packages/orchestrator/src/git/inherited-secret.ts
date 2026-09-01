/**
 * Read a secret output this job inherited from a `needs` upstream.
 *
 * Backs the reserved `needs:` context in a qualified credential reference. The
 * value was written by `ctx.setSecretOutput`, is encrypted at rest in
 * `run_secret_outputs`, and is deleted when the run completes — so this reads
 * the store that already exists rather than adding a second one.
 */

import { decrypt as pskDecrypt, deriveKey } from '@kici-dev/shared';
import type { SecretOutputStore } from '../secrets/secret-output-store.js';

export interface InheritedSecretDeps {
  secretOutputStore: SecretOutputStore;
  /** Upstream job ids for a job, in the same shape the run merge path uses. */
  upstreamJobIds: (runId: string, jobId: string) => Promise<string[]>;
  /** The orchestrator's master secret key, as configured. */
  secretKey: string;
}

/**
 * Build the `secretOutputs` lookup the credential broker takes.
 *
 * Returns null when the key was not published by any upstream — the broker
 * turns that into an actionable error naming `setSecretOutput`.
 */
export function createInheritedSecretReader(deps: InheritedSecretDeps) {
  return async (runId: string, jobId: string, key: string): Promise<string | null> => {
    const upstreamIds = await deps.upstreamJobIds(runId, jobId);
    if (upstreamIds.length === 0) return null;

    const outputs = await deps.secretOutputStore.getUpstreamSecretOutputs(runId, upstreamIds);
    for (const jobOutputs of Object.values(outputs)) {
      const encrypted = jobOutputs[key];
      if (encrypted === undefined) continue;
      return pskDecrypt(
        { data: encrypted, keyVersion: 1 },
        deriveKey(deps.secretKey),
        `secret-output:${runId}`,
      );
    }
    return null;
  };
}
