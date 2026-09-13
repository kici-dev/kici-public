/**
 * Capability negotiation schemas — bidirectional.
 *
 * Modeled after peerCapabilitiesSchema in peer.ts.
 *
 * Two directions, each advertised as the sending side learns what the other
 * understands:
 * - **orchestrator → Platform** (`orchCapabilitiesSchema`, sent in `auth.request`):
 *   the Platform pre-flight-checks orchestrator capabilities before sending
 *   feature-gated messages (e.g. the dashboard-request manifest).
 * - **Platform → orchestrator** (`platformCapabilitiesSchema`, advertised once
 *   after auth): a self-hosted orchestrator can run *ahead* of the hosted
 *   Platform, so it pre-flight-checks its own feature-gated sends against what
 *   the Platform advertises — surfacing a diagnosable capability gap instead of
 *   firing a frame the Platform would drop.
 *
 * Pattern (both directions): each field indicates support for an optional
 * protocol feature. Missing fields default to unsupported for backward
 * compatibility; `.passthrough()` preserves unknown flags from a newer peer.
 * A peer that never advertises at all is treated as "unknown" (optimistic),
 * never as "supports nothing".
 */
import { z } from 'zod';
import { dashboardWritePolicyMap } from '../dashboard-write-operations.js';
import { dashboardEncryptionJwkSchema } from './dashboard-sealed-write.js';
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
    /**
     * The orchestrator's active X25519 dashboard-encryption public key. Feeds
     * the Convenient tier: the key reaches the hosted control plane over the
     * authenticated orchestrator connection, and the dashboard fetches it from
     * there when no verified issuer is configured. Absent on builds without the
     * key (no `KICI_SECRET_KEY`, or not yet provisioned) — the dashboard then
     * fails closed rather than sending plaintext.
     */
    dashboardEncryptionKey: dashboardEncryptionJwkSchema.optional(),
    /**
     * The verified-tier origin the dashboard should fetch the encryption key
     * from directly (bypassing the control plane), from the orchestrator's
     * `dashboard_verified_issuer` cluster setting. Null/absent ⇒ the Verified
     * tier is not offered and the Convenient tier applies.
     */
    dashboardVerifiedIssuer: z.string().nullable().optional(),
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

/**
 * Platform-advertised capabilities sent to the orchestrator after auth.
 * Uses .passthrough() so a newer Platform's unknown flags are preserved.
 * Every field is optional and absent = unsupported (same evolution contract as
 * `orchCapabilitiesSchema`).
 */
export const platformCapabilitiesSchema = z
  .object({
    /** Platform ingests periodic `orch.metrics` telemetry pushes. */
    orchMetrics: z.boolean().optional(),
    /** Platform serves the orchestrator-initiated `oidc.mint.request` RPC. */
    oidcMint: z.boolean().optional(),
  })
  .passthrough();

/** Inferred type for Platform capabilities. */
export type PlatformCapabilities = z.infer<typeof platformCapabilitiesSchema>;

/** Default Platform capabilities advertised to the orchestrator after auth. */
export const PLATFORM_CAPABILITIES = Object.freeze({
  orchMetrics: true,
  oidcMint: true,
} satisfies PlatformCapabilities);

/**
 * Check whether the Platform advertises a specific capability flag.
 *
 * Takes `string` (not `keyof`) because a newer Platform may advertise flags the
 * current orchestrator build doesn't know about. Returns false if capabilities
 * is undefined (nothing advertised yet) or the flag is missing/false.
 *
 * NOTE: "undefined → false" here is the plain reader semantics. A feature-gated
 * SEND that must stay backward-safe against a pre-capability Platform (which
 * never advertises) treats "nothing advertised yet" as optimistic-send — that
 * layer lives in the orchestrator's `sendIfPlatformSupports`, not here.
 */
export function hasPlatformCapability(
  capabilities: PlatformCapabilities | undefined,
  flag: string,
): boolean {
  return (capabilities as Record<string, unknown> | undefined)?.[flag] === true;
}

/**
 * Orchestrator -> Agent capabilities, advertised on `register.ack`. Same
 * evolution contract as the other two directions: every field optional,
 * absent = unsupported, `.passthrough()` preserves a newer orchestrator's
 * unknown flags. Lets the agent learn which optional agent-facing protocol
 * features this orchestrator build supports.
 */
export const orchAgentCapabilitiesSchema = z
  .object({
    /**
     * Orchestrator acks `artifacts.upload.complete` (with committed|failed) so
     * the agent can fail the workflow step on a lost commit instead of losing
     * the artifact silently. Absent -> agent stays fire-and-forget.
     */
    artifactCompleteAck: z.boolean().optional(),
  })
  .passthrough();

/** Inferred type for orchestrator -> agent capabilities. */
export type OrchAgentCapabilities = z.infer<typeof orchAgentCapabilitiesSchema>;

/** Default orchestrator -> agent capabilities advertised on register.ack. */
export const ORCH_AGENT_CAPABILITIES = Object.freeze({
  artifactCompleteAck: true,
} satisfies OrchAgentCapabilities);

/**
 * Check whether an orchestrator advertises a specific agent-facing capability
 * flag.
 *
 * Takes `string` (not `keyof`) because a newer orchestrator may advertise flags
 * this agent build doesn't know about. Returns false if capabilities is
 * undefined (pre-capability orchestrator) or the flag is missing/false.
 */
export function hasOrchAgentCapability(
  capabilities: OrchAgentCapabilities | undefined,
  flag: string,
): boolean {
  return (capabilities as Record<string, unknown> | undefined)?.[flag] === true;
}
