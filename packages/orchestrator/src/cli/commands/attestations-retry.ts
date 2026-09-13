/**
 * `kici-admin attestations retry` runner. Triggers an immediate drain of the
 * deferred-attestation outbox on the running orchestrator via the admin API —
 * minting happens in the orchestrator process, which owns the authenticated
 * Platform WebSocket. `--run-id` scopes to one run; otherwise the whole outbox
 * drains (the `--all-pending` flag is the explicit form of the default).
 */

export interface AttestationRetryOptions {
  runId?: string;
  allPending?: boolean;
  includeRejected?: boolean;
}

export interface AttestationRetryResult {
  minted: number;
  stillPending: number;
  rejected: number;
}

/**
 * Post the retry request through the injected transport (the admin API POST)
 * and return the counts. Validates that the scope is unambiguous. When
 * `includeRejected` is set, previously terminally-rejected rows are re-armed
 * and re-attempted in the same drain.
 */
export async function runAttestationRetry(
  post: (body: { runId?: string; includeRejected?: boolean }) => Promise<AttestationRetryResult>,
  opts: AttestationRetryOptions,
): Promise<AttestationRetryResult> {
  const base = opts.includeRejected ? { includeRejected: true } : {};
  if (!opts.runId && !opts.allPending) {
    // Default to draining everything, but keep the explicit flags meaningful.
    return post(base);
  }
  return post(opts.runId ? { ...base, runId: opts.runId } : base);
}
