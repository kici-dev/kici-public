/**
 * Multi-context merge helpers for the orchestrator dispatch path.
 *
 * A job may bind several contexts in order; their resolved secrets/variables
 * fold last-wins and their protection gates combine all-must-pass. Browser-safe
 * (no Node built-ins), so the engine context barrel exports it.
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
 * Fold ordered per-context maps into one, last-wins, matching the documented
 * merge order for `contexts: [...]`.
 */
export function mergeOrderedMaps(
  maps: ReadonlyArray<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) Object.assign(out, m);
  return out;
}
