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
