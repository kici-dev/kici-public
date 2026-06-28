/**
 * Orchestrator capability negotiation schemas.
 *
 * Modeled after peerCapabilitiesSchema in peer.ts.
 * See CONTEXT.md through for design decisions.
 *
 * Direction: orchestrator → Platform only. The Platform is always at the latest version
 * (centrally deployed), so Platform capabilities are unnecessary. The Platform checks
 * orchestrator capabilities before sending feature-gated messages.
 *
 * Pattern: Each field indicates support for an optional protocol feature.
 * Missing fields default to unsupported for backward compatibility.
 * Schema uses .passthrough() so newer orchestrators sending unknown flags don't get stripped.
 */
import { z } from 'zod';
import { dashboardWritePolicyMap } from '../dashboard-write-operations.js';
import { DASHBOARD_REQUEST_TYPES } from './dashboard.js';

/** Orchestrator role in a cluster topology. */
export const OrchRole = z.enum(['coordinator', 'worker']);
export type OrchRole = z.infer<typeof OrchRole>;

/**
 * Orchestrator-advertised capabilities sent in auth.request.
 * Uses .passthrough() so newer orchestrators sending unknown flags are preserved.
 */
export const orchCapabilitiesSchema = z
  .object({
    /** Orchestrator's role in the cluster (coordinator manages DB/vault, worker is stateless). */
    orchRole: OrchRole.optional(),
    /**
     * Per-operation dashboard-write policy. Sparse map where each
     * present key flips one `DashboardWriteOperation` to false. Missing
     * keys are treated as `true` (permissive default). Sent on auth so
     * Platform's per-org cache populates immediately; rebroadcast via
     * the standalone `orch.capabilities.update` message on policy
     * change (see platform-orchestrator.ts).
     */
    dashboardWrites: dashboardWritePolicyMap.optional(),
    /**
     * Every `dashboard.*` request type this orchestrator build understands.
     * The Platform pre-flight-checks an incoming dashboard request against this
     * set and refuses (with a precise "upgrade orchestrator" error) when the
     * type is absent. Derived from the orchestrator's own protocol schema, so it
     * cannot drift. Absent on pre-capability builds → treated as "unknown",
     * never as "supports nothing".
     */
    supportedDashboardRequests: z.array(z.string()).optional(),
  })
  .passthrough();

/** Inferred type for orchestrator capabilities. */
export type OrchCapabilities = z.infer<typeof orchCapabilitiesSchema>;

/** Default orchestrator capabilities sent in auth.request. */
export const ORCH_CAPABILITIES = Object.freeze({
  orchRole: OrchRole.enum.coordinator,
  supportedDashboardRequests: [...DASHBOARD_REQUEST_TYPES],
} satisfies OrchCapabilities);

/**
 * Check whether an orchestrator advertises a specific capability flag.
 *
 * Takes `string` (not `keyof`) because newer versions may have flags the current code
 * doesn't know about. Returns false if capabilities is undefined (pre-capability
 * orchestrator) or the flag is missing/false.
 */
export function hasOrchCapability(
  capabilities: OrchCapabilities | undefined,
  flag: string,
): boolean {
  return (capabilities as Record<string, unknown> | undefined)?.[flag] === true;
}
