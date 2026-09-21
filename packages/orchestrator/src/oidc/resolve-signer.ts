/**
 * Bounded wait for the orchestrator's provenance signer.
 *
 * A mint that arrives before the leader has generated the key must NOT fall
 * back to a Platform-signed bundle (it would fail verification against the
 * orchestrator trust root), so the resolver waits for the key instead of
 * deferring on the first miss. But the wait exists for ONE condition — a
 * reconcile that returns `null` because a non-leader has not yet seen the row
 * the leader is about to write. A reconcile that THROWS is a different answer:
 * a signing key sealed under a master key this process does not hold, or `db`
 * custody with no master key at all. Neither changes across the wait, so
 * retrying it for the full window only turns every mint into a silent
 * thirty-second stall that ends in the same `unavailable` defer, with the
 * cause — which the reconcile phrases as an operator recovery instruction —
 * swallowed on every attempt.
 *
 * So: retry the null, stop on the throw, and say why once per distinct cause.
 */
import type { Signer } from './signer.js';

export interface ResolveSignerOptions {
  /** One reconcile pass: a signer, `null` while the key is not ready, or a throw. */
  reconcile: () => Promise<{ signer: Signer } | null>;
  /** Attempts before giving up on a still-null reconcile. */
  maxAttempts: number;
  /** Delay between two null attempts. */
  delayMs: number;
  /** Sink for the terminal-cause line; called once per distinct message. */
  logError: (message: string, meta: Record<string, unknown>) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build a memoizing resolver: the first successful reconcile is cached for the
 * life of the process, a null reconcile is retried up to `maxAttempts` times,
 * and a thrown reconcile ends the call at once with `null`.
 */
export function createBoundedSignerResolver(
  opts: ResolveSignerOptions,
): () => Promise<Signer | null> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));
  let cached: Signer | null = null;
  let lastReportedCause: string | undefined;
  return async () => {
    if (cached) return cached;
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      let reconciled: { signer: Signer } | null;
      try {
        reconciled = await opts.reconcile();
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        if (cause !== lastReportedCause) {
          lastReportedCause = cause;
          opts.logError('provenance signing key cannot be loaded; mints will defer until fixed', {
            error: cause,
          });
        }
        return null;
      }
      if (reconciled) {
        cached = reconciled.signer;
        lastReportedCause = undefined;
        return cached;
      }
      await sleep(opts.delayMs);
    }
    return null;
  };
}
