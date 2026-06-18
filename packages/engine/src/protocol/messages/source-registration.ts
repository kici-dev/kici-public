import { z } from 'zod';

// --- Source registration protocol messages ---
// Used during WebSocket connection setup: orchestrator pushes its webhook source
// configuration to Platform, which responds with an acknowledgment.

/**
 * Fine-grained source subtype, used by the dashboard (and any future filtering /
 * grouping logic) to render an icon and friendly label for each source.
 *
 * Distinct from `provider` (which collapses universal-git, generic_webhook, and
 * local into the single value `'generic'`): subtype keeps the "what kind of
 * orchestrator-side wiring is this?" distinction visible all the way through
 * the API and UI.
 *
 * - `github_app`     — orchestrator-side `sources` row with `provider='github'`
 *                      (a GitHub App registration).
 * - `generic_webhook` — `generic_webhook_sources` row with `provider_type='generic'`.
 * - `universal_git`   — `generic_webhook_sources` row with a non-null `git_config`
 *                      (universal-git provider — gitea, gitlab, forgejo, etc.).
 * - `local`           — `generic_webhook_sources` row with `provider_type='local'`
 *                      (a git repository present on the agent's filesystem,
 *                      cloned via `file://`).
 */
export const SourceSubtype = z.enum(['github_app', 'generic_webhook', 'universal_git', 'local']);
export type SourceSubtype = z.infer<typeof SourceSubtype>;

/**
 * Source provider family used by Platform's webhook router. Coarser-grained
 * than `SourceSubtype` — every universal-git / generic_webhook / local row
 * collapses to `'generic'` here because Platform routes them through the same
 * generic webhook ingress.
 */
export const SourceProvider = z.enum(['github', 'gitlab', 'bitbucket', 'generic']);
export type SourceProvider = z.infer<typeof SourceProvider>;

/** Source registration sent by orchestrator to Platform after auth.success. */
export const sourceRegistrationSchema = z.object({
  type: z.literal('source.register'),
  messageId: z.string(),
  sources: z.array(
    z.object({
      provider: SourceProvider,
      routingKey: z.string(),
      /**
       * Human-readable source name (e.g. "Production GitHub App",
       * "Internal staging webhook"). Required — orchestrators always have a
       * name in their local `sources` / `generic_webhook_sources` row.
       */
      name: z.string(),
      /**
       * Fine-grained source subtype. See {@link SourceSubtype} for the full
       * mapping. Required — pre-release, no backward-compat shims.
       */
      subtype: SourceSubtype,
    }),
  ),
  /** Orchestrator cluster instance ID for peer correlation. */
  instanceId: z.string().optional(),
  /**
   * Human-friendly cluster name resolved on orch boot (`cluster_meta.cluster_name`).
   * Used by Platform to populate the per-orch dashboard URL segment
   * (`/orgs/:cId/orchestrators/:clusterName/...`). Validation happens
   * Platform-side via `clusterNameSchema`. Platform accepts N
   * connected orchestrators per `(org_id, cluster_name)` — HA-cluster
   * siblings share one cluster identity — and the dashboard listing
   * dedupes by cluster name server-side.
   */
  clusterName: z.string().optional(),
  /**
   * Orchestrator DB identifier (UUID, seeded by orch migration 001 in
   * `cluster_meta` key `'cluster_id'`). Lets Platform distinguish two
   * different orchestrator clusters that accidentally share the same
   * `clusterName` in one org: every coord in an HA cluster shares the
   * same orch DB and therefore the same `clusterId`, while two unrelated
   * clusters carry distinct UUIDs. Optional — older orchestrators that
   * haven't been redeployed yet won't publish it, in which case Platform
   * skips the cross-cluster collision warn for that connection.
   */
  clusterId: z.string().uuid().optional(),
  /** Reachable address for peer-to-peer connections (from KICI_CLUSTER_ADDRESS env var). */
  address: z.string().nullable().optional(),
  /** Orchestrator version (e.g. "0.0.1"). Optional for backward compatibility with older orchestrators. */
  version: z.string().optional(),
  /** Orchestrator config mode. Optional for backward compatibility. */
  mode: z.enum(['platform', 'hybrid', 'independent']).optional(),
  /** Scaler backends configured on this orchestrator (e.g. ["container", "firecracker"]). */
  scalerBackends: z.array(z.string()).optional(),
  /** Whether this orchestrator has S3 log storage configured. Used for multi-orch pool validation. */
  s3LogAccess: z.boolean().optional(),
  /** Queue timeout in ms. Platform uses this (with margin) for safety-net GC of stale queued jobs. */
  queueTimeoutMs: z.number().optional(),
});

/**
 * One accepted source in a {@link sourceRegistrationAckSchema}. Carries the
 * public webhook URL the Platform computed for this routing key so the
 * orchestrator (which only knows its org *alias*, never the canonical org id)
 * can surface it to the operator — e.g. `kici-admin source add` printing the
 * URL to paste into a GitHub App. `webhookUrl` is null when the Platform has
 * no public webhook base configured (`config.webhookPublicUrl` unset).
 */
export const acceptedSourceSchema = z.object({
  routingKey: z.string(),
  webhookUrl: z.string().nullable(),
});
export type AcceptedSource = z.infer<typeof acceptedSourceSchema>;

/** Platform acknowledgment of source registration. */
export const sourceRegistrationAckSchema = z.object({
  type: z.literal('source.register.ack'),
  messageId: z.string(),
  accepted: z.array(acceptedSourceSchema),
  rejected: z.array(
    z.object({
      routingKey: z.string(),
      reason: z.string(),
    }),
  ),
  /** Other orchestrators sharing overlapping routing keys (peer discovery). */
  peers: z
    .array(
      z.object({
        connectionId: z.string(),
        instanceId: z.string().optional(),
        address: z.string().nullable(),
        routingKeys: z.array(z.string()),
      }),
    )
    .optional(),
});

/** Source deregistration sent by orchestrator to Platform at runtime (e.g., after config reload removes an app). */
export const sourceDeregisterSchema = z.object({
  type: z.literal('source.deregister'),
  messageId: z.string(),
  routingKeys: z.array(z.string()),
});

/** Platform acknowledgment of source deregistration. */
export const sourceDeregisterAckSchema = z.object({
  type: z.literal('source.deregister.ack'),
  messageId: z.string(),
  removed: z.array(z.string()),
});

// --- Inferred types ---

export type SourceRegistration = z.infer<typeof sourceRegistrationSchema>;
export type SourceRegistrationAck = z.infer<typeof sourceRegistrationAckSchema>;
export type SourceDeregister = z.infer<typeof sourceDeregisterSchema>;
export type SourceDeregisterAck = z.infer<typeof sourceDeregisterAckSchema>;
