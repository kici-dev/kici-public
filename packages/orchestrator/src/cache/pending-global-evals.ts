/**
 * Pending tracker for the Tier-2 global eval round.
 *
 * One round job per (event × workflow repo) returns a verdict per candidate
 * workflow.
 *
 * Unlike the dynamic-eval and init trackers, this round runs BEFORE any run row
 * exists: its purpose is to decide which global workflows produce a run at all,
 * so creating one up-front would defeat it.
 */

import { globalEvalRoundResultSchema, type GlobalEvalRoundResult } from '@kici-dev/engine';
import { PendingTracker } from './pending-tracker.js';

/**
 * Validate the round result carried on a `job.status` message before it reaches
 * the tracker.
 *
 * **This is the one place the round's wire payload is validated.** The status
 * message's `data` is `z.record(z.string(), z.unknown())`, so nothing upstream
 * checks `globalEvalResult` against its schema, and any agent that owns the round
 * job can send an arbitrary value — a cast at the message handler would be an
 * unchecked type assertion. Parsing here keeps the "typed but unvalidated"
 * boundary at one named function instead of every consumer.
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
      // Called synchronously on the WebSocket message path, so a throw escapes
      // into the agent handler's un-awaited promise and terminates the process.
      // Defence in depth behind `parseGlobalEvalResult`: an unparsed resolve gets
      // a degraded log line, never an unhandled rejection.
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
