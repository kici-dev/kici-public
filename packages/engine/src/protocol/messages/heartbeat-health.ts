/**
 * Heartbeat-freshness policy for Platform connection and agent health.
 *
 * Two distinct policies live here, and their numbers differ on purpose.
 *
 * **Rendering policy** — badge freshness, computed from `last_heartbeat_at` on
 * a DB row, by any instance. Advisory: nothing routes on a badge, so it can
 * afford a tight bound. Two independent heartbeat domains consult it — Platform
 * connection health (platform_connections) and agent liveness in the
 * dashboard's infrastructure tree — so the two badges cannot drift apart.
 * Browser-safe so the dashboard renders against the same numbers the server
 * computes with.
 *
 * **Teardown policy** — applied by the owning instance to its own live sockets.
 * Wider than the rendering bounds because the `platform_connections.status`
 * write it drives gates every `status = 'connected'` reader — among them the
 * plan-limit connection count, the cross-instance relay lookup, the dashboard
 * proxy's owning-instance lookup, and the stale-orchestrator detector. Marking
 * a live socket unhealthy too eagerly removes it from routing while it is still
 * serving.
 *
 * The two policies also cover different lifetimes. An instance that closes a
 * socket at HEARTBEAT_CLOSE_MS deletes its row in the same step, so the `stale`
 * (HEARTBEAT_DEGRADED_MS) and `orphaned` (HEARTBEAT_STALE_THRESHOLD_SECONDS)
 * levels describe rows that delete never ran for — the ones the orphan sweeper
 * reaps. That is why the sweeper cutoff sits at twice HEARTBEAT_CLOSE_MS: a
 * clean close always beats the sweep to the row.
 *
 * Neither policy has an unclassified case, which is what makes them safe to
 * keep separate: the rendering policy maps a missing `last_heartbeat_at` to
 * `orphaned` (worst-case, no heartbeat evidence at all), and the teardown
 * policy never encounters one because the registry stamps `lastHeartbeatAt` at
 * registration. Any future attempt to collapse the two must preserve that — an
 * unknown treated as healthy hides a dead peer, and one treated as unhealthy
 * sheds a live one.
 *
 * Consumers:
 *  - platform ws/connection-health.ts       — the four-level status computation
 *  - platform ws/heartbeat.ts               — the teardown policy
 *  - platform queue/jobs/orphan-sweeper.ts  — periodic DELETE of orphan rows
 *  - platform ws/registry.ts                — plan-limit count excludes stale rows
 *  - platform dashboard/routes/admin.ts     — GET /admin/connections filter enum
 *  - platform dev-ops/developer-ops.ts      — the diagnostics badge + orphan count
 *  - dashboard utils/diagnostics-helpers.ts — agent heartbeat badge colour
 */
import { z } from 'zod';

// ── Rendering policy ────────────────────────────────────────────────

/** A heartbeat younger than this is fully healthy. */
export const HEARTBEAT_FRESH_MS = 60_000;

/** Between fresh and this, the peer is degraded but not yet presumed gone. */
export const HEARTBEAT_DEGRADED_MS = 300_000;

/**
 * A row is considered stale (the owning orchestrator process is no longer
 * publishing heartbeats) when `last_heartbeat_at` is older than this. Past it,
 * the connection is orphaned and the sweeper is entitled to delete the row.
 *
 * The Platform's same-instance DB eviction on reconnect
 * (`ws/handler.ts#handleSourceRegistration`) shares this rationale: the DELETE
 * itself is unconditional on staleness, but the reason it is needed at all is
 * this same staleness window.
 */
export const HEARTBEAT_STALE_THRESHOLD_SECONDS = 360;

// ── Teardown policy ─────────────────────────────────────────────────

/**
 * Silence after which the owning instance writes
 * `platform_connections.status = 'unhealthy'`. Wider than HEARTBEAT_FRESH_MS
 * because that write gates relay routing, not rendering.
 */
export const HEARTBEAT_UNHEALTHY_MARK_MS = 90_000;

/**
 * Silence after which the owning instance closes the socket with
 * WS_CLOSE_HEARTBEAT_TIMEOUT (4004) and drops it from the registry — which
 * deletes the platform_connections row too. A row outlives its socket only when
 * that delete never ran; the orphan sweeper reaps those.
 */
export const HEARTBEAT_CLOSE_MS = 180_000;

/** The four-level connection health vocabulary, worst-last. */
export const connectionHealthStatusSchema = z.enum(['connected', 'unhealthy', 'stale', 'orphaned']);
export type ConnectionHealthStatus = z.infer<typeof connectionHealthStatusSchema>;
