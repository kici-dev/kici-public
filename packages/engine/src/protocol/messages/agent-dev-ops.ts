/**
 * Agent-facing, provenance-tagged shapes for the developer MCP's read tools
 * beyond runs: organizations, connected orchestrators, diagnostics, and secret
 * scope key names. Same discipline as {@link ./agent-run-result.js}: every
 * user/process-controlled value (org and cluster names, routing keys, scope and
 * secret key names) is wrapped in an {@link untrusted} envelope so the fencing
 * renderer keeps it out of an agent's instruction channel; KiCI-generated ids,
 * enum statuses, counts, and timestamps stay plain (trusted).
 *
 * Browser-safe (zod only) so it can ride the engine barrel alongside the rest
 * of the agent-facing read contract.
 */
import { z } from 'zod';
import { untrusted } from './agent-run-result.js';
import { connectionHealthStatusSchema } from './heartbeat-health.js';

const untrustedString = untrusted(z.string());
const untrustedStringNullable = untrusted(z.string()).nullable();

/**
 * Organization the calling user belongs to. `displayName` / `publicAlias` are
 * user-chosen → untrusted; the id, the owner flag, and the creation timestamp
 * are trusted.
 */
export const agentOrgSummarySchema = z.object({
  id: z.string(),
  publicAlias: untrustedStringNullable,
  displayName: untrustedString,
  isOwner: z.boolean(),
  createdAt: z.string().nullable(),
});
export type AgentOrgSummary = z.infer<typeof agentOrgSummarySchema>;

/**
 * Connected orchestrator cluster (the customer-deployed data plane the org's
 * runs execute on). The cluster name and routing keys carry user/source-derived
 * content → untrusted; versions, modes, roles, scaler-backend enum tags, the S3
 * flag, ids, and timestamps are trusted.
 */
export const agentOrchestratorSummarySchema = z.object({
  connectionId: z.string(),
  clusterName: untrustedStringNullable,
  routingKeys: z.array(untrustedString),
  orchVersion: z.string().nullable(),
  orchMode: z.string().nullable(),
  orchRole: z.string().nullable(),
  scalerBackends: z.array(z.string()),
  s3LogAccess: z.boolean(),
  connectedAt: z.string(),
  lastHeartbeatAt: z.string(),
});
export type AgentOrchestratorSummary = z.infer<typeof agentOrchestratorSummarySchema>;

/** One orchestrator connection row inside the diagnostics summary. */
export const agentDiagnosticsConnectionSchema = z.object({
  connectionId: z.string(),
  healthBadge: connectionHealthStatusSchema,
  routingKeys: z.array(untrustedString),
  lastHeartbeatAt: z.string().nullable(),
});

/**
 * Org diagnostics summary: execution metrics over the last 24h plus per-orch
 * connection health. All metrics/counts/badges are KiCI-computed (trusted); only
 * the routing keys carry user content.
 */
export const agentDiagnosticsSchema = z.object({
  executionMetrics: z.object({
    totalRuns: z.number().int(),
    successRate: z.number(),
    avgDurationSeconds: z.number(),
    queuedJobs: z.number().int(),
    runningJobs: z.number().int(),
  }),
  orchestrators: z.array(agentDiagnosticsConnectionSchema),
  orphanedConnections: z.number().int(),
});
export type AgentDiagnostics = z.infer<typeof agentDiagnosticsSchema>;

/**
 * A secret scope and the key NAMES it holds — never values. Both the scope name
 * and each key name are user-chosen → untrusted. This is the read contract for
 * `list_secrets`: an agent can discover which secret keys exist without ever
 * being handed a secret value.
 */
export const agentSecretScopeSchema = z.object({
  scope: untrustedString,
  keys: z.array(untrustedString),
});
export type AgentSecretScope = z.infer<typeof agentSecretScopeSchema>;
