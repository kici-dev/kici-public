/**
 * Multi-context merge helpers shared across the orchestrator dispatch path.
 *
 * A job may bind several contexts in order; their resolved
 * secrets/variables are folded last-wins (a later context's key overrides an
 * earlier one) and their protection gates combine all-must-pass. This module is
 * browser-safe (pure functions + a Zod enum, no Node built-ins) so it can be
 * exported from the engine context barrel.
 */
import { z } from 'zod';

/**
 * Reason a single bound context rejects a run under all-must-pass
 * aggregation. Used to name which context and which rule blocked dispatch.
 */
export const ContextGateRejectReason = z.enum([
  'branch_restricted',
  'trigger_filtered',
  'repo_unmatched',
  'trust_too_low',
  'context_disabled',
  'context_not_found',
]);
export type ContextGateRejectReason = z.infer<typeof ContextGateRejectReason>;

/**
 * Fold an ordered list of per-context resolved maps into one. Later entries
 * override earlier keys (last-wins), matching the documented merge order for
 * `contexts: [...]`.
 */
export function mergeOrderedMaps(
  maps: ReadonlyArray<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) Object.assign(out, m);
  return out;
}
