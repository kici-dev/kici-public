/**
 * `kici-admin attestations retry`: drains the deferred-attestation outbox now,
 * through the admin API, because minting runs in the orchestrator process that
 * owns the Platform WebSocket. `--run-id` scopes to one run; otherwise the whole
 * outbox drains (`--all-pending` is the explicit form of the default).
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

/** `includeRejected` re-arms terminally-rejected rows and retries them in the same drain. */
export async function runAttestationRetry(
  post: (body: { runId?: string; includeRejected?: boolean }) => Promise<AttestationRetryResult>,
  opts: AttestationRetryOptions,
): Promise<AttestationRetryResult> {
  const base = opts.includeRejected ? { includeRejected: true } : {};
  if (!opts.runId && !opts.allPending) {
    return post(base);
  }
  return post(opts.runId ? { ...base, runId: opts.runId } : base);
}
