import { z } from 'zod';
import { authRequestSchema, authSuccessSchema, authFailureSchema } from './auth.js';
import { OrchRole, orchCapabilitiesSchema, platformCapabilitiesSchema } from './capabilities.js';
import { heartbeatSchema, nackSchema } from './common.js';
import { LogStream } from './log-stream.js';
import {
  executionStatusSchema,
  stepStatusForwardSchema,
  jobStatusForwardSchema,
  stateReplaySchema,
  REPO_IDENTIFIER_MAX,
} from './execution-status.js';
import {
  sourceRegistrationSchema,
  sourceRegistrationAckSchema,
  sourceDeregisterSchema,
  sourceDeregisterAckSchema,
} from './source-registration.js';
import { dashboardPlatformToOrchSchema } from './dashboard.js';
import { runEventMessageSchema, jobContextMessageSchema } from './run-events.js';

// --- Platform -> Orchestrator messages ---

export const SECONDS_PER_HOUR = 3600;

/**
 * Documented default window a security hold stays open: 72 hours. The
 * fail-closed policy, the orchestrator's stored-policy default, and the
 * hold-sizing fallback all read it, so it cannot drift between the two
 * packages that enforce it.
 */
export const DEFAULT_APPROVAL_EXPIRY_SECONDS = 72 * SECONDS_PER_HOUR;

/**
 * The shortest security-hold window. One second, not a rounder number: the
 * floor only stops a zero or negative value minting an already-expired hold,
 * and a larger floor would put short windows out of reach of a test.
 */
export const MIN_APPROVAL_EXPIRY_SECONDS = 1;

/** The longest window the Platform accepts: one year. */
export const MAX_APPROVAL_EXPIRY_SECONDS = 8760 * SECONDS_PER_HOUR;

/**
 * The org trust policy's fork switch: how fork pull requests are treated. Each
 * value names the operator's choice; which values the orchestrator's
 * trust-policy gate honours, and how, is owned there.
 *
 * - `ignore` — the operator declines fork pull requests.
 * - `hold` — the operator requires approval first; the policy's approval expiry
 *   bounds how long that approval stays open.
 * - `allow` — the operator permits fork pull requests to run with reduced
 *   privilege.
 */
export const ForkPolicy = z.enum(['ignore', 'hold', 'allow']);
export type ForkPolicy = z.infer<typeof ForkPolicy>;

/**
 * How much CI authority one org member holds. The `/kici approve` comment path
 * reads it once it has resolved a commenter to a KiCI user id: `write` or
 * `admin` may release a security hold, `read` and `none` may not. Shared by the
 * wire schema, the orchestrator's admin route, and `kici-admin`.
 */
export const CiTrustLevel = z.enum(['none', 'read', 'write', 'admin']);
export type CiTrustLevel = z.infer<typeof CiTrustLevel>;

/**
 * Org trust policy: Platform-owned tenant policy pushed to the orchestrator,
 * which caches and enforces it but never owns it. Named apart from the
 * enclosing message so the orchestrator's evaluator and cache can type against
 * the policy alone.
 *
 * `.strict()`: a sender emitting the per-arm fields the gate never read is on a
 * build this protocol floor refuses, so a stray field is a version-skew signal,
 * not something to ignore.
 */
export const trustPolicySchema = z
  .object({
    forkPolicy: ForkPolicy,
    /**
     * Seconds a security hold stays open. Integer because the column is
     * INTEGER: a fractional value throws inside the fire-and-forget persist and
     * the policy is silently never stored. At least
     * {@link MIN_APPROVAL_EXPIRY_SECONDS}: a non-positive window mints an
     * already-expired hold.
     */
    approvalExpirySeconds: z.number().int().min(MIN_APPROVAL_EXPIRY_SECONDS),
  })
  .strict();
export type TrustPolicy = z.infer<typeof trustPolicySchema>;

/** Trust policy update pushed from Platform to orchestrator when policy or identity links change. */
export const trustPolicyUpdateSchema = z.object({
  type: z.literal('trust_policy.update'),
  orgId: z.string(),
  policy: trustPolicySchema,
  identityLinks: z.array(
    z.object({
      userId: z.string(),
      provider: z.string(),
      providerUsername: z.string(),
      /**
       * Immutable IDP-side numeric id (e.g. GitHub's `id`); nullish for legacy
       * rows that predate the column. The trust resolver matches strictly on
       * this id, never on `providerUsername`, and refuses a match when either
       * side lacks it.
       */
      providerUserId: z.string().nullish(),
    }),
  ),
  memberCiTrustLevels: z.record(z.string(), CiTrustLevel),
  /**
   * Operator-defined teams and their member user ids, delivered here and cached
   * in memory because the orchestrator has no identity store. The approval
   * resolver matches a `{team}` clause against this list. `.default([])` keeps
   * an older Platform that does not send it valid.
   */
  teamMemberships: z
    .array(
      z.object({
        teamName: z.string(),
        memberUserIds: z.array(z.string()),
      }),
    )
    .default([]),
});
export type TrustPolicyUpdate = z.infer<typeof trustPolicyUpdateSchema>;

/**
 * Internal shape of a fully-reassembled, HMAC-verified webhook relay handed
 * to the orchestrator's `onWebhookRelay` callback.
 *
 * NOT wire-parseable: it is absent from `platformToOrchestratorMessageSchema`
 * so a rogue or compromised Platform cannot fabricate one and bypass the
 * on-orchestrator HMAC verification. The Platform holds no webhook secrets, so
 * the orch-side `verifyInboundWebhook` (called from `onVerifyInbound` on the
 * chunked `webhook.relay.start` / `webhook.relay.chunk` path) is the sole trust
 * boundary against a malicious Platform. The only construction site is
 * `completeChunkedRelay` in `packages/orchestrator/src/ws/platform-client.ts`,
 * AFTER `onVerifyInbound` returns `'accepted'`.
 */
export const webhookRelaySchema = z.object({
  type: z.literal('webhook.relay'),
  messageId: z.string(),
  routingKey: z.string(),
  deliveryId: z.string(),
  event: z.string(),
  action: z.string().nullish(),
  payload: z.unknown(),
  /** Trace ID propagated across tiers for distributed tracing. */
  requestId: z.string().optional(),
});

/**
 * Verification + processing result in `webhook.ack`. On the chunked relay the
 * orchestrator, not the Platform, verifies the inbound HMAC signature against
 * its locally-stored secret.
 *
 * - `accepted`: signature verified (or method is `none`/IP allowlist OK), webhook
 *   handed to the existing webhook processing pipeline.
 * - `rejected_signature`: signature did not match any rotation secret. Maps to HTTP 401.
 * - `rejected_unknown_source`: the routing key is not registered on this orchestrator
 *   (or the provider is not yet implemented). Maps to HTTP 404 + Platform negative cache.
 * - `rejected_misconfigured`: the orchestrator has the source but its verification config
 *   is malformed (e.g. invalid JSON in generic_webhook_sources.verification_config) or
 *   the chunked stream itself was malformed (out-of-order, oversize, base64 decode fail,
 *   missing chunks at finalization, TTL expiry). Maps to HTTP 500.
 * - `shed_retry_later`: the orchestrator's ingest admission controller is
 *   saturated and shed this delivery (event-loop overload or per-org/global
 *   cap). Maps to HTTP 429 + Retry-After — a terminal, RETRYABLE result: the
 *   caller redelivers, the delivery is not lost, and Platform does NOT fail
 *   over to a pool peer (peers share the same overloaded orchestrator DB).
 */
export const WebhookRelayResult = z.enum([
  'accepted',
  'rejected_signature',
  'rejected_unknown_source',
  'rejected_misconfigured',
  'shed_retry_later',
]);
export type WebhookRelayResult = z.infer<typeof WebhookRelayResult>;

/**
 * Maximum total body size of the chunked webhook relay: 25 MiB, GitHub's own
 * webhook payload cap. Senders that need more connect to their orchestrator
 * directly, bypassing the Platform.
 */
export const WEBHOOK_RELAY_MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Recommended raw chunk size for the chunked relay: 64 KiB raw is ~85 KiB
 * base64 in JSON, which permessage-deflate compresses well. The Platform picks
 * the actual size; the orchestrator enforces only totalSize and chunkCount.
 */
export const WEBHOOK_RELAY_CHUNK_SIZE = 64 * 1024;

/**
 * Start frame of the chunked webhook relay (Platform -> orchestrator): metadata
 * and signature inputs only; body bytes follow in webhook.relay.chunk frames
 * with the same messageId. The orchestrator allocates a per-messageId
 * reassembly buffer and sends no webhook.ack until the final chunk.
 */
export const webhookRelayStartSchema = z.object({
  type: z.literal('webhook.relay.start'),
  messageId: z.string(),
  routingKey: z.string(),
  deliveryId: z.string(),
  event: z.string(),
  action: z.string().nullish(),
  /** Inbound HTTP signature header NAME (lowercased, e.g. `x-hub-signature-256`). */
  signatureHeaderName: z.string().nullish(),
  /** Inbound HTTP signature header VALUE (the claimed HMAC, e.g. `sha256=abc...`). */
  signatureHeader: z.string().nullish(),
  /** Inbound HTTP request client IP for IP-allowlist verification (generic webhooks). */
  clientIp: z.string().nullish(),
  /**
   * Selected inbound headers (lowercased keys). Senders SHOULD include only
   * headers the verification path uses (signature alt-name, x-hub-signature,
   * etc.) and route metadata, never bulk headers.
   */
  headers: z.record(z.string(), z.string()),
  /** Total body size in bytes; a decoded-chunk sum that differs yields rejected_misconfigured. */
  totalSize: z.number().int().min(0).max(WEBHOOK_RELAY_MAX_BODY_BYTES),
  chunkCount: z.number().int().min(1),
  /** Trace ID propagated across tiers for distributed tracing. */
  requestId: z.string().optional(),
});
export type WebhookRelayStart = z.infer<typeof webhookRelayStartSchema>;

/**
 * One body chunk. Chunks MUST arrive strictly in `sequence` order; the
 * `final` chunk completes the stream and triggers verify+process on the
 * orchestrator. The decoded bytes across the stream MUST sum to the `totalSize`
 * declared in webhook.relay.start.
 */
export const webhookRelayChunkSchema = z.object({
  type: z.literal('webhook.relay.chunk'),
  messageId: z.string(),
  /** 0-indexed; must match the orchestrator's expected next sequence. */
  sequence: z.number().int().min(0),
  /** Base64-encoded chunk bytes. */
  data: z.string(),
  final: z.boolean(),
});
export type WebhookRelayChunk = z.infer<typeof webhookRelayChunkSchema>;

/** Peer discovery notification sent by Platform when another orchestrator shares routing keys. */
export const peerDiscoverSchema = z.object({
  type: z.literal('peer.discover'),
  peer: z.object({
    connectionId: z.string(),
    /** The peer's self-reported cluster instance ID (from source.register). */
    instanceId: z.string().optional(),
    address: z.string().nullable(),
    routingKeys: z.array(z.string()),
  }),
});

/** Full peer list pushed by the Platform to all pool members on a membership change. Replaces peer.discover. */
export const peerUpdateSchema = z.object({
  type: z.literal('peer.update'),
  peers: z.array(
    z.object({
      connectionId: z.string(),
      instanceId: z.string().optional(),
      address: z.string().nullable(),
      routingKeys: z.array(z.string()),
      orchRole: OrchRole.optional(),
    }),
  ),
});

/**
 * Sent by the Platform when a replacement orchestrator reconnects after the
 * previous one died: the runs the Platform marked timed_out_stale, so the
 * orchestrator can update the GitHub check runs the dead one left
 * "in_progress".
 */
export const staleCheckrunCleanupSchema = z.object({
  type: z.literal('stale.checkrun.cleanup'),
  runs: z.array(
    z.object({
      runId: z.string(),
      provider: z.string(),
      routingKey: z.string(),
      repoIdentifier: z.string(),
      sha: z.string(),
      workflowName: z.string(),
      /**
       * The repository that DEFINES the workflow, when it is not the one the
       * run acted on (an organization-wide workflow dispatched against another
       * repository). The orchestrator qualifies the check-run names it looks
       * for with it, so a cleanup cannot time out the acted-on repository's own
       * same-named check; see the orchestrator's `workflowLabel`.
       *
       * The Platform sends it only when the two repositories differ, the same
       * condition that writes the mirror column, so an absent field and a value
       * equal to `repoIdentifier` both name the unqualified check.
       */
      workflowRepoIdentifier: z.string().max(REPO_IDENTIFIER_MAX).optional(),
      jobNames: z.array(z.string()),
    }),
  ),
});
export type StaleCheckrunCleanup = z.infer<typeof staleCheckrunCleanupSchema>;

/**
 * Sent once by the Platform after the orchestrator authenticates.
 * `platformCapabilitiesSchema` defines no flag at protocol 4.
 */
export const platformCapabilitiesMessageSchema = z.object({
  type: z.literal('platform.capabilities'),
  capabilities: platformCapabilitiesSchema,
});
export type PlatformCapabilitiesMessage = z.infer<typeof platformCapabilitiesMessageSchema>;

// --- Orchestrator -> Platform messages ---

/**
 * Periodic OTel metrics push from orchestrator to Platform.
 *
 * The schema bounds are the first defence against polluting the Platform's
 * monitoring: a malformed or hostile push fails Zod parse at the WS edge and
 * never reaches the aggregator or the Mimir relay. The content allow-list
 * (catalog) is enforced deeper, in the Platform's orchestrator-metrics filter.
 *
 * Caps, with headroom over current use:
 * - 2000 metric data points per push (one orch ships ~60)
 * - 128-char metric name, 64-char label key, 256-char label value
 * - 15 labels per series (KiCI metrics carry ~5)
 * - 30 explicit histogram buckets (largest histogram has 9 boundaries)
 */
export const orchMetricsSchema = z.object({
  type: z.literal('orch.metrics'),
  messageId: z.string().max(128),
  metrics: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        type: z.enum(['counter', 'histogram', 'gauge', 'upDownCounter']),
        value: z.number().optional(),
        labels: z
          .record(z.string().max(64), z.string().max(256))
          .refine((m) => Object.keys(m).length <= 15, {
            message: 'metric carries more than 15 labels',
          })
          .optional(),
        buckets: z
          .array(z.object({ le: z.number(), count: z.number() }))
          .max(30)
          .optional(),
        count: z.number().optional(),
        sum: z.number().optional(),
      }),
    )
    .max(2000),
  timestamp: z.number(),
});
export type OrchMetrics = z.infer<typeof orchMetricsSchema>;

/** Largest worker-peer snapshot accepted on one frame. */
export const CLUSTER_MEMBERSHIP_MAX_WORKERS = 512;

/**
 * Worker-peer membership snapshot, sent by a coordinator to the Platform.
 *
 * A snapshot rather than a delta, so a dropped or reordered frame self-heals on
 * the next send instead of corrupting a running tally. The Platform stores the
 * size on `platform_connections` and adds it to the org's combined
 * orchestrator count. The array bound makes a malformed or hostile push fail
 * Zod parse at the WS edge, as in `orchMetricsSchema`.
 */
export const clusterMembershipSchema = z.object({
  type: z.literal('cluster.membership'),
  workers: z
    .array(z.object({ instanceId: z.string().min(1).max(128) }))
    .max(CLUSTER_MEMBERSHIP_MAX_WORKERS),
  timestamp: z.number(),
});
export type ClusterMembership = z.infer<typeof clusterMembershipSchema>;

/**
 * Per-coordinator orchestrator ceiling, pushed by the Platform.
 *
 * `maxWorkerPeers` is an ABSOLUTE ceiling on this coordinator's connected
 * worker peers, not a remaining allowance. The Platform excludes this
 * connection's own workers from the org total, so the value does not move when
 * a local worker joins or leaves and the coordinator enforces against its live
 * peer count with no round trip and no staleness window.
 *
 * `orgLimit` and `orgTotal` are informational, so the coordinator's rejection
 * reason can say why. `evictExcess` is set once the org has been over its limit
 * for longer than the grace window, and asks the coordinator to drain its
 * newest workers down to the ceiling.
 */
export const planHeadroomSchema = z.object({
  type: z.literal('plan.headroom'),
  maxWorkerPeers: z.number().int().min(0),
  orgLimit: z.number().int().min(0),
  orgTotal: z.number().int().min(0),
  evictExcess: z.boolean(),
});
export type PlanHeadroom = z.infer<typeof planHeadroomSchema>;

/** Acknowledgment that a webhook was received and processing started. */
export const webhookAckSchema = z.object({
  type: z.literal('webhook.ack'),
  messageId: z.string(),
  deliveryId: z.string(),
  result: WebhookRelayResult,
  /**
   * Diagnostic for a rejection. MUST NOT include any secret material (HMAC
   * keys, bearer tokens, computed signatures).
   */
  reason: z.string().nullish(),
});

/** Execution lifecycle event reported back to Platform. */
export const executionEventSchema = z.object({
  type: z.literal('execution.event'),
  messageId: z.string(),
  runId: z.string(),
  event: z.enum(['started', 'job_dispatched', 'job_completed', 'finished']),
  data: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
});

/** Streaming log chunk from job execution. */
export const logChunkSchema = z.object({
  type: z.literal('log.chunk'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  lines: z.array(z.string()),
  timestamp: z.number(),
  stream: LogStream,
});

/**
 * Phase of an orchestration/provisioning log line, as written into the
 * orchestrator's per-job JSONL files; the dashboard's run-detail orch-log viewer
 * splits by it. `unknown` covers a missing or unrecognized stored phase.
 */
export const OrchLogPhase = z.enum(['dispatch', 'setup', 'provisioning', 'teardown', 'unknown']);
export type OrchLogPhase = z.infer<typeof OrchLogPhase>;

/**
 * Live orchestration/provisioning log lines pushed orchestrator -> Platform.
 *
 * Emitted at the orchestrator's `writeOrchLog` / provisioning-write tap points,
 * alongside persisting to LogStorage, which stays the authoritative backfill
 * source. The Platform fans it out to browser subscribers keyed by
 * `(runId, jobId)` as `orch-log.lines`. `lines` are the raw message strings for
 * this phase; `ts` is the write timestamp (ms).
 *
 * Best-effort: fire-and-forget at the write site, so a push failure never
 * breaks dispatch. Unlike step `log.chunk` it is not acked or fast-pathed and
 * carries no `messageId`.
 */
export const orchLogChunkSchema = z.object({
  type: z.literal('orch-log.chunk'),
  runId: z.string(),
  jobId: z.string(),
  phase: OrchLogPhase,
  lines: z.array(z.string()),
  ts: z.number(),
});
export type OrchLogChunk = z.infer<typeof orchLogChunkSchema>;

/** Cache lookup statistics forwarded from orchestrator to Platform for centralized metrics. */
export const cacheStatsSchema = z.object({
  type: z.literal('cache.stats'),
  cacheType: z.enum(['source', 'dep']),
  hit: z.boolean(),
});
export type CacheStats = z.infer<typeof cacheStatsSchema>;

/**
 * Runtime broadcast of an updated dashboard-write policy, sent whenever an
 * operator flips a switch via `kici-admin org-settings dashboard-writes`. It
 * carries the orch's full capabilities object (as in `auth.request`) so the
 * Platform replaces its per-org cache wholesale rather than merging, then
 * re-broadcasts the relevant subset to connected dashboard sessions.
 */
const orchCapabilitiesUpdateSchema = z.object({
  type: z.literal('orch.capabilities.update'),
  capabilities: orchCapabilitiesSchema,
});

// --- Direction-specific discriminated unions ---

/** All messages that flow from Platform to Orchestrator.
 *
 * The single-frame `webhookRelaySchema` is NOT a member: its `payload` is
 * attacker-controlled, and accepting it on the wire would let a compromised
 * Platform fabricate deliveries that bypass on-orch HMAC verification (see
 * `webhookRelaySchema`). The chunked `webhook.relay.start` +
 * `webhook.relay.chunk` path is the sole route from the Platform to
 * `onWebhookRelay`. */
export const platformToOrchestratorMessageSchema = z.discriminatedUnion('type', [
  webhookRelayStartSchema,
  webhookRelayChunkSchema,
  trustPolicyUpdateSchema,
  sourceRegistrationAckSchema,
  sourceDeregisterAckSchema,
  authSuccessSchema,
  authFailureSchema,
  peerDiscoverSchema,
  peerUpdateSchema,
  staleCheckrunCleanupSchema,
  platformCapabilitiesMessageSchema,
  planHeadroomSchema,
  // The reply to a frame whose type the receiver does not understand (version
  // skew). In BOTH direction unions since either side can NACK the other.
  nackSchema,
  // Derived from the dashboard-direction union so the two cannot drift: a
  // dashboard request type missing here is silently dropped by the
  // orchestrator's frame parser and surfaces only as a dashboard proxy timeout.
  ...dashboardPlatformToOrchSchema.options,
]);

/** All messages that flow from Orchestrator to Platform.
 *
 * Dashboard response messages (dashboard.run.detail.response, etc.) are
 * excluded: they are parsed via dashboardOrchToPlatformSchema so the Platform
 * WS handler routes them to the DashboardProxy for request correlation. */
export const orchestratorToPlatformMessageSchema = z.discriminatedUnion('type', [
  webhookAckSchema,
  executionEventSchema,
  logChunkSchema,
  orchLogChunkSchema,
  executionStatusSchema,
  stepStatusForwardSchema,
  jobStatusForwardSchema,
  stateReplaySchema,
  orchCapabilitiesUpdateSchema,
  sourceRegistrationSchema,
  sourceDeregisterSchema,
  cacheStatsSchema,
  authRequestSchema,
  heartbeatSchema,
  runEventMessageSchema,
  jobContextMessageSchema,
  orchMetricsSchema,
  clusterMembershipSchema,
  nackSchema,
]);

// --- Recognized-type sets (single source of truth for the NACK classifier) ---

/** Minimal structural shape of a Zod object schema carrying a `type` literal. */
type TypeLiteralObjectSchema = { shape: { type: { value: string } } };

/**
 * The discriminator `type` values a schema recognizes: every option of a
 * discriminated union, or the single `type` literal of an object schema. Same
 * `schema.options.map((o) => o.shape.type.value)` idiom as
 * `DASHBOARD_REQUEST_TYPES`, so a set derived through it cannot drift from its
 * schema.
 */
export function collectDiscriminatorTypes(
  schema: { options: readonly TypeLiteralObjectSchema[] } | TypeLiteralObjectSchema,
): string[] {
  if ('options' in schema) {
    return schema.options.map((option) => option.shape.type.value);
  }
  return [schema.shape.type.value];
}

/**
 * Every message `type` the orchestrator→Platform mainline union recognizes.
 * The Platform WS handler unions this with its extra recognition-chain schemas
 * (log-pull, dashboard responses, cluster join) to decide whether a frame that
 * failed validation is a known-but-invalid type (close the connection) or a
 * genuinely-unknown one (version-skew NACK + keep alive).
 */
export const ORCH_TO_PLATFORM_RECOGNIZED_TYPES: ReadonlySet<string> = new Set(
  collectDiscriminatorTypes(orchestratorToPlatformMessageSchema),
);

/**
 * Every message `type` the Platform→orchestrator mainline union recognizes,
 * dashboard request types included. The orchestrator's platform client unions
 * it with its extra recognition-chain schemas for the same known-but-invalid vs
 * unknown decision.
 */
export const PLATFORM_TO_ORCH_RECOGNIZED_TYPES: ReadonlySet<string> = new Set(
  collectDiscriminatorTypes(platformToOrchestratorMessageSchema),
);

// --- Inferred types ---

export type WebhookRelay = z.infer<typeof webhookRelaySchema>;
export type WebhookAck = z.infer<typeof webhookAckSchema>;
export type LogChunk = z.infer<typeof logChunkSchema>;
export type PeerDiscover = z.infer<typeof peerDiscoverSchema>;
export type PeerUpdate = z.infer<typeof peerUpdateSchema>;
export type PlatformToOrchestratorMessage = z.infer<typeof platformToOrchestratorMessageSchema>;
export type OrchestratorToPlatformMessage = z.infer<typeof orchestratorToPlatformMessageSchema>;
// ExecutionStatus and StepStatusForward types live in execution-status.ts; re-exporting
// them here would duplicate the type definitions.
