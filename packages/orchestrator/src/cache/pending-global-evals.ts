/**
 * Pending tracker for the Tier-2 global eval round.
 *
 * The orchestrator dispatches one round job per (event × workflow repo) and
 * waits for the agent to return a verdict per candidate workflow. The
 * underlying tracker logic lives in `PendingTracker<GlobalEvalRoundResult>`;
 * this subclass wires the round-specific logger prefix and disconnect error.
 *
 * Unlike the dynamic-eval and init trackers, this round runs BEFORE any run row
 * exists: its whole purpose is to decide which global workflows produce a run at
 * all, so creating one up-front would defeat it.
 */

import { globalEvalRoundResultSchema, type GlobalEvalRoundResult } from '@kici-dev/engine';
import { PendingTracker } from './pending-tracker.js';

/**
 * Validate the round result carried on a `job.status` message before it reaches
 * the tracker.
 *
 * **This is the one place the round's wire payload is validated.** The status
 * message's `data` field is `z.record(z.string(), z.unknown())`, so nothing
 * upstream checks `globalEvalResult` against its schema — a cast at the message
 * handler would be a type assertion over an arbitrary agent-supplied value, and
 * any agent that owns the round job can send one. Parsing here keeps the
 * "typed but unvalidated" boundary at a single named function instead of spread
 * across every consumer.
 *
 * The parsed value is widened back to {@link GlobalEvalRoundResult}: the schema
 * is deliberately loose about `jobs` (the lock-job shape has no Zod mirror), and
 * the dispatch path re-checks every generated job before it builds anything from
 * one.
 */
export function parseGlobalEvalResult(
  raw: unknown,
): { ok: true; value: GlobalEvalRoundResult } | { ok: false; error: string } {
  const parsed = globalEvalRoundResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Global eval round returned a malformed result: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    };
  }
  return { ok: true, value: parsed.data as GlobalEvalRoundResult };
}

export class PendingGlobalEvalTracker extends PendingTracker<GlobalEvalRoundResult> {
  constructor() {
    super({
      logPrefix: 'pending-global-evals',
      itemLabel: 'global eval round',
      disconnectError: 'Global eval agent disconnected',
      // `PendingTracker.resolve` calls this synchronously on the WebSocket
      // message path, so a throw here escapes into the agent handler's
      // un-awaited promise and terminates the process. Defence in depth behind
      // `parseGlobalEvalResult`: a caller that resolves without parsing first
      // gets a degraded log line, never an unhandled rejection.
      extractResolveMeta: (r) => {
        const candidates = Array.isArray(r?.candidates) ? r.candidates : [];
        return {
          candidateCount: candidates.length,
          runCount: candidates.filter((c) => c?.run === true).length,
        };
      },
    });
  }
}
