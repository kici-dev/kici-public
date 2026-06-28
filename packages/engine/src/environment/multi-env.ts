/**
 * Multi-environment merge helpers shared across the orchestrator dispatch path.
 *
 * A job may bind several deployment environments in order; their resolved
 * secrets/variables are folded last-wins (a later environment's key overrides an
 * earlier one) and their protection gates combine all-must-pass. This module is
 * browser-safe (pure functions + a Zod enum, no Node built-ins) so it can be
 * exported from the engine environment barrel.
 */
import { z } from 'zod';

/**
 * Reason a single bound environment rejects a run under all-must-pass
 * aggregation. Used to name which environment and which rule blocked dispatch.
 */
export const EnvGateRejectReason = z.enum([
  'branch_restricted',
  'trigger_filtered',
  'repo_unmatched',
  'trust_too_low',
  'env_disabled',
  'env_not_found',
]);
export type EnvGateRejectReason = z.infer<typeof EnvGateRejectReason>;

/**
 * Fold an ordered list of per-environment resolved maps into one. Later entries
 * override earlier keys (last-wins), matching the documented merge order for
 * `environments: [...]`.
 */
export function mergeOrderedMaps(
  maps: ReadonlyArray<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) Object.assign(out, m);
  return out;
}
