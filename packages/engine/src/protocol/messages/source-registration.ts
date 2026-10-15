import { z } from 'zod';
import { DeploymentIdentitySchema } from './deployment-identity.js';
import { ConfigPathsSchema } from './config-paths.js';

// --- Source registration protocol messages ---
// At WebSocket connection setup the orchestrator pushes its webhook sources to
// the Platform, which acknowledges them.

/**
 * Fine-grained source subtype; the dashboard renders an icon and friendly label
 * from it. Unlike `provider`, which collapses universal-git, generic_webhook and
 * local into `'generic'`, it keeps the kind of orchestrator-side wiring visible
 * through the API and UI.
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
 * Operating mode of a customer-deployed orchestrator: the `KICI_MODE`
 * vocabulary read by the orchestrator config schema, the `source.register`
 * protocol message, and the Platform's relay-eligibility filter.
 *
 * - `platform`    — the hosted Platform relays every webhook; no local ingress.
 * - `hybrid`      — Platform relay **plus** the orchestrator's own direct
 *                   (GitHub / generic) ingress; full hosted observability.
 * - `observed`    — the orchestrator ingests only its OWN webhooks (nothing
 *                   transits the Platform) but keeps its Platform WebSocket for
 *                   hosted observability. The Platform never relays to it and
 *                   records its sources as observe-only.
 * - `independent` — own ingress only, no Platform connection at all.
 */
export const OrchestratorMode = z.enum(['platform', 'hybrid', 'independent', 'observed']);
export type OrchestratorMode = z.infer<typeof OrchestratorMode>;

/**
 * Modes in which the orchestrator holds a Platform WebSocket connection (and so
 * requires `KICI_PLATFORM_URL` + `KICI_PLATFORM_TOKEN`). `observed` connects for
 * observability + observe-only source registration; `independent` never does.
 */
export const PLATFORM_CONNECTED_MODES: readonly OrchestratorMode[] = [
  OrchestratorMode.enum.platform,
  OrchestratorMode.enum.hybrid,
  OrchestratorMode.enum.observed,
];

/**
 * Modes in which the orchestrator accepts Platform-relayed webhooks. `observed`
 * is deliberately absent: it ingests only its own webhooks, and both sides
 * enforce that (the orchestrator refuses any relay it receives, and the Platform
 * excludes observed connections from every relay-candidate lookup).
 */
export const RELAY_INGRESS_MODES: readonly OrchestratorMode[] = [
  OrchestratorMode.enum.platform,
  OrchestratorMode.enum.hybrid,
];

/**
 * Modes in which the orchestrator serves its OWN webhook ingress (the direct
 * GitHub route plus generic webhook sources).
 */
export const OWN_INGRESS_MODES: readonly OrchestratorMode[] = [
  OrchestratorMode.enum.hybrid,
  OrchestratorMode.enum.independent,
  OrchestratorMode.enum.observed,
];

/**
 * Source provider family used by the Platform's webhook router. Every
 * universal-git / generic_webhook / local row is `'generic'` because the
 * Platform routes them through the same generic webhook ingress.
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
       * Human-readable source name (e.g. "Production GitHub App"). Required:
       * every local `sources` / `generic_webhook_sources` row has one.
       */
      name: z.string(),
      /** See {@link SourceSubtype}. Required — pre-release, no backward-compat shims. */
      subtype: SourceSubtype,
      /**
       * GitHub App slug (the URL-safe identifier GitHub assigns, e.g.
       * `my-kici-app`). Set only for GitHub-App sources, where GitHub owns both
       * the display `name` and the `slug`, and unset until the identity fetch
       * has run.
       */
      slug: z.string().min(1).optional(),
    }),
  ),
  /** Orchestrator cluster instance ID for peer correlation. */
  instanceId: z.string().optional(),
  /**
   * Cluster name resolved on orch boot (`cluster_meta.cluster_name`); the
   * per-orch dashboard URL segment (`/orgs/:cId/orchestrators/:clusterName/...`).
   * The Platform validates it with `clusterNameSchema` and accepts N connected
   * orchestrators per `(org_id, cluster_name)`, since HA-cluster siblings share
   * one cluster identity; the dashboard listing dedupes by cluster name
   * server-side.
   */
  clusterName: z.string().optional(),
  /**
   * Orchestrator DB identifier (UUID, seeded by orch migration 001 in
   * `cluster_meta` key `'cluster_id'`). Every coord in an HA cluster shares one
   * orch DB and so one `clusterId`, which lets the Platform tell apart two
   * unrelated clusters that share a `clusterName` in one org. Absent when the
   * orchestrator could not read it; the Platform then skips the cross-cluster
   * collision warning for that connection.
   */
  clusterId: z.string().uuid().optional(),
  /** Reachable address for peer-to-peer connections (from KICI_CLUSTER_ADDRESS env var). */
  address: z.string().nullable().optional(),
  /** Orchestrator version (e.g. "0.0.1"). Absent when the orchestrator cannot read its own version. */
  version: z.string().optional(),
  mode: OrchestratorMode.optional(),
  /** Scaler backends configured on this orchestrator (e.g. ["container", "firecracker"]). */
  scalerBackends: z.array(z.string()).optional(),
  /**
   * How the orchestrator process itself was deployed. Absent when the
   * orchestrator cannot detect it; the dashboard then treats the shape as
   * `unknown`.
   */
  deployment: DeploymentIdentitySchema.optional(),
  /**
   * Where this orchestrator's own config files live on its host, so the
   * dashboard can point an operator straight at them. Each member is omitted
   * independently when that path is not knowable.
   */
  configPaths: ConfigPathsSchema.optional(),
  /** Whether this orchestrator has S3 log storage configured. Used for multi-orch pool validation. */
  s3LogAccess: z.boolean().optional(),
  /** Queue timeout in ms. Platform uses this (with margin) for safety-net GC of stale queued jobs. */
  queueTimeoutMs: z.number().optional(),
});

/**
 * One accepted source in a {@link sourceRegistrationAckSchema}. Carries the
 * public webhook URL the Platform computed for the routing key, because the
 * orchestrator knows only its org *alias*, never the canonical org id; e.g.
 * `kici-admin source add` prints it to paste into a GitHub App. `webhookUrl` is
 * null when `config.webhookPublicUrl` is unset on the Platform.
 */
const acceptedSourceSchema = z.object({
  routingKey: z.string(),
  webhookUrl: z.string().nullable(),
});

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
