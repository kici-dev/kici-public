/**
 * Capability schemas — bidirectional.
 *
 * Modeled after peerCapabilitiesSchema in peer.ts.
 *
 * - **orchestrator → Platform** (`orchCapabilitiesSchema`, sent in `auth.request`
 *   and rebroadcast as `orch.capabilities.update`): the orchestrator's role and
 *   the dashboard settings the Platform caches per org.
 * - **Platform → orchestrator** (`platformCapabilitiesSchema`, advertised once
 *   after auth), **orchestrator → agent** (`orchAgentCapabilitiesSchema`, on
 *   `register.ack`) and **agent → orchestrator** (`agentCapabilitiesSchema`, on
 *   `agent.register`): each defines no flag at protocol 4 and is advertised
 *   empty. A later release adds a flag to one of them without a protocol bump.
 *
 * Every schema uses `.passthrough()`, so a newer peer's unknown fields are
 * preserved rather than stripped.
 */
import { z } from 'zod';
import { dashboardWritePolicyMap } from '../dashboard-write-operations.js';
import { dashboardEncryptionJwkSchema } from './dashboard-sealed-write.js';

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
    orchRole: OrchRole,
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
} satisfies OrchCapabilities);

/** Platform-advertised capabilities sent to the orchestrator after auth. */
export const platformCapabilitiesSchema = z.object({}).passthrough();

/** Inferred type for Platform capabilities. */
export type PlatformCapabilities = z.infer<typeof platformCapabilitiesSchema>;

/** Default Platform capabilities advertised to the orchestrator after auth. */
export const PLATFORM_CAPABILITIES = Object.freeze({} satisfies PlatformCapabilities);

/** Orchestrator -> agent capabilities, advertised on `register.ack`. */
export const orchAgentCapabilitiesSchema = z.object({}).passthrough();

/** Inferred type for orchestrator -> agent capabilities. */
export type OrchAgentCapabilities = z.infer<typeof orchAgentCapabilitiesSchema>;

/** Default orchestrator -> agent capabilities advertised on register.ack. */
export const ORCH_AGENT_CAPABILITIES = Object.freeze({} satisfies OrchAgentCapabilities);

/** Agent -> orchestrator capabilities, advertised on `agent.register`. */
export const agentCapabilitiesSchema = z.object({}).passthrough();

/** Inferred type for agent -> orchestrator capabilities. */
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/** Default agent -> orchestrator capabilities advertised on agent.register. */
export const AGENT_CAPABILITIES = Object.freeze({} satisfies AgentCapabilities);
