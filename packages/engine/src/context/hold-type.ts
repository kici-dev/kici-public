import { z } from 'zod';

/**
 * Why a context protection gate paused a run. Shared by the engine domain
 * types, the orchestrator gates, and the dashboard held-run UI.
 *
 * The orchestrator persists these verbatim into `held_runs.hold_type`. The
 * column and its wire field stay `string` (see the held-runs list response
 * schema) so an older or newer orchestrator's hold type never rejects the
 * relayed message.
 */
export const HoldType = z.enum(['reviewer', 'timer', 'concurrency', 'security']);
export type HoldType = z.infer<typeof HoldType>;
