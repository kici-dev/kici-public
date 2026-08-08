import { z } from 'zod';

/**
 * Protection-gate hold-type vocabulary — the reason a run is paused by a
 * context protection gate. Single source of truth for the four gate hold
 * types shared across the engine domain types, the orchestrator gates, and the
 * dashboard held-run UI.
 *
 * The orchestrator persists these verbatim into `held_runs.hold_type`, so the
 * column, the wire and the dashboard all speak one vocabulary. The column and
 * the wire field it rides on stay typed as `string` (see the held-runs list
 * response schema) so an older/newer orchestrator's hold type never rejects the
 * relayed message.
 */
export const HoldType = z.enum(['reviewer', 'timer', 'concurrency', 'security']);
export type HoldType = z.infer<typeof HoldType>;

/**
 * Legacy persisted `held_runs.hold_type` spellings → the gate vocabulary.
 *
 * A row written by an un-upgraded orchestrator can carry `approval` for a
 * reviewer hold or `wait_timer` for a workflow-install wait hold. Writers emit
 * the gate vocabulary and a migration backfills the column, so this map exists
 * for those older rows — it is what lets the two sides deploy independently
 * instead of in lockstep.
 */
const LEGACY_HOLD_TYPES: Readonly<Record<string, HoldType>> = Object.freeze({
  approval: HoldType.enum.reviewer,
  wait_timer: HoldType.enum.timer,
});

/**
 * Map a persisted hold type onto the gate vocabulary.
 *
 * An unrecognised value passes through unchanged rather than being coerced to a
 * default: the wire field is `z.string()` precisely so a newer orchestrator's
 * hold type survives an older reader, and the dashboard's gray fallback badge
 * is the correct rendering for a genuinely unknown type.
 */
export function normalizePersistedHoldType(raw: string): string {
  // `Object.hasOwn`, not a bare index: an object literal inherits
  // `Object.prototype`, so indexing it with `toString` / `constructor` /
  // `valueOf` yields a function instead of `undefined` and the `??` never
  // fires. That would return a non-string from a `string` function and put it
  // on the wire, where `z.string()` rejects the whole relayed held-runs
  // message — the exact failure the forward-compatible schema exists to avoid.
  return Object.hasOwn(LEGACY_HOLD_TYPES, raw) ? LEGACY_HOLD_TYPES[raw] : raw;
}

/**
 * Every spelling `held_runs.hold_type` may hold for one gate hold type — the
 * current one first, then any legacy alias that normalizes onto it.
 *
 * For queries that must match a hold type in SQL, where the row-by-row
 * `normalizePersistedHoldType` cannot run. Feeding this into an `IN (…)` filter
 * keeps a sweep matching rows an un-upgraded orchestrator wrote, and keeps the
 * legacy spellings out of call sites as bare literals.
 */
export function persistedHoldTypeSpellings(type: HoldType): string[] {
  const aliases = Object.keys(LEGACY_HOLD_TYPES).filter(
    (spelling) => LEGACY_HOLD_TYPES[spelling] === type,
  );
  return [type, ...aliases];
}
