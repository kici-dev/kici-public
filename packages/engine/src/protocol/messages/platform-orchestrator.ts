import { z } from 'zod';
import { authRequestSchema, authSuccessSchema, authFailureSchema } from './auth.js';
import { orchCapabilitiesSchema } from './capabilities.js';
import { heartbeatSchema } from './common.js';
import {
  executionStatusSchema,
  stepStatusForwardSchema,
  jobStatusForwardSchema,
  stateReplaySchema,
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

/** Trust policy update pushed from Platform to orchestrator when policy or identity links change. */
export const trustPolicyUpdateSchema = z.object({
  type: z.literal('trust_policy.update'),
  orgId: z.string(),
  policy: z.object({
    forkPolicy: z.enum(['hold', 'reject', 'allow']),
    unknownContributorPolicy: z.enum(['hold', 'reject']),
    workflowChangePolicy: z.enum(['hold', 'reject', 'allow']),
    approvalExpiryHours: z.number(),
  }),
  identityLinks: z.array(
    z.object({
      userId: z.string(),
      provider: z.string(),
      providerUsername: z.string(),
      /**
       * Immutable IDP-side numeric id (e.g. GitHub's `id`).
       * Nullable during the backfill window for legacy rows that
       * predate the column. Trust resolver prefers this over
       * `providerUsername` and (in the strict end-state) refuses
       * trust when both sides have it null.
       */
      providerUserId: z.string().nullish(),
    }),
  ),
  memberCiTrustLevels: z.record(z.string(), z.enum(['none', 'read', 'write', 'admin'])),
  /**
   * Operator-defined teams and their member user ids. The orchestrator has no
   * identity store, so team membership is delivered here (next to
   * `identityLinks`) and cached in-memory. The approval resolver matches a
   * `{team}` clause by looking up the team's members in this list.
   * `.default([])` keeps an older Platform that doesn't send it valid.
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
 * NOT a wire-parseable schema: this shape is intentionally absent from the
 * `platformToOrchestratorMessageSchema` discriminated union so that a rogue
 * or compromised Platform process (A10) cannot fabricate one and bypass the
 * on-orchestrator HMAC verification gate. The only legitimate construction
 * site is `completeChunkedRelay` in `packages/orchestrator/src/ws/platform-client.ts`,
 * which synthesizes this shape AFTER `onVerifyInbound` returns `'accepted'`.
 *
 * Migration `packages/platform/src/db/migrations/012_drop_webhook_secret_columns.ts`
 * makes the orch-side `verifyInboundWebhook` (called from `onVerifyInbound` on
 * the chunked relay path `webhook.relay.start` / `webhook.relay.chunk`) the
 * sole trust boundary against a malicious Platform; keeping this schema OUT
 * of the wire union enforces that invariant statically.
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
 * HMAC verification + processing result returned by orchestrator in webhook.ack.
 *
 * Used in the chunked relay protocol where the orchestrator (not Platform)
 * verifies the inbound HMAC signature against its locally-stored secret.
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
 */
export const WebhookRelayResult = z.enum([
  'accepted',
  'rejected_signature',
  'rejected_unknown_source',
  'rejected_misconfigured',
]);
export type WebhookRelayResult = z.infer<typeof WebhookRelayResult>;

/**
 * Maximum total body size accepted by the chunked webhook relay protocol.
 * 25 MiB matches GitHub's own webhook payload cap. Senders that need higher must
 * connect their orchestrator directly (bypassing Platform).
 */
export const WEBHOOK_RELAY_MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Recommended raw chunk size for the chunked relay protocol. 64 KiB raw becomes
 * ~85 KiB base64 in JSON; permessage-deflate compresses it well. Sender (Platform)
 * picks the actual size; receiver (orchestrator) just enforces totalSize and chunkCount.
 */
export const WEBHOOK_RELAY_CHUNK_SIZE = 64 * 1024;

/**
 * Start frame of the chunked webhook relay protocol (Platform -> orchestrator).
 * Carries metadata + signature inputs only; body bytes follow in subsequent
 * webhook.relay.chunk frames correlated by messageId.
 *
 * The orchestrator allocates a per-messageId reassembly buffer on receipt.
 * No webhook.ack is sent until the final chunk completes the stream.
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
   * Selected inbound headers the orchestrator may need (lowercased keys). Senders
   * SHOULD include only headers the verification path uses (signature alt-name,
   * x-hub-signature, etc.) and route metadata; bulk header forwarding is an
   * anti-pattern.
   */
  headers: z.record(z.string(), z.string()),
  /**
   * Total body size in bytes. Sum of decoded chunk sizes MUST equal this value;
   * mismatch yields rejected_misconfigured. Capped at WEBHOOK_RELAY_MAX_BODY_BYTES.
   */
  totalSize: z.number().int().min(0).max(WEBHOOK_RELAY_MAX_BODY_BYTES),
  /** Number of chunk frames the orchestrator should expect (>= 1). */
  chunkCount: z.number().int().min(1),
  /** Trace ID propagated across tiers for distributed tracing. */
  requestId: z.string().optional(),
});
export type WebhookRelayStart = z.infer<typeof webhookRelayStartSchema>;

/**
 * One chunk of the body. Sequence is 0-indexed and MUST arrive strictly in order;
 * the final=true chunk completes the stream and triggers verify+process on the
 * orchestrator. Decoded chunk bytes (sum across the stream) MUST equal totalSize
 * declared in webhook.relay.start.
 */
export const webhookRelayChunkSchema = z.object({
  type: z.literal('webhook.relay.chunk'),
  messageId: z.string(),
  /** 0-indexed chunk number; must match the orchestrator's expected next sequence. */
  sequence: z.number().int().min(0),
  /** Base64-encoded chunk bytes. */
  data: z.string(),
  /** True on the last chunk in the stream. Triggers verify+process on the orchestrator. */
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

/** Full peer list update pushed by Platform to all pool members when membership changes. Replaces peer.discover. */
export const peerUpdateSchema = z.object({
  type: z.literal('peer.update'),
  peers: z.array(
    z.object({
      connectionId: z.string(),
      instanceId: z.string().optional(),
      address: z.string().nullable(),
      routingKeys: z.array(z.string()),
      orchRole: z.enum(['coordinator', 'worker']).optional(),
    }),
  ),
});

/**
 * Stale check run cleanup request sent by Platform when a replacement orchestrator
 * reconnects after the previous one died. Contains metadata for runs that were
 * marked timed_out_stale by Platform, so the orchestrator can update stuck GitHub
 * check runs that the dead orchestrator left as "in_progress".
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
      jobNames: z.array(z.string()),
    }),
  ),
});
export type StaleCheckrunCleanup = z.infer<typeof staleCheckrunCleanupSchema>;

// --- Orchestrator -> Platform messages ---

/**
 * Periodic OTel metrics push from orchestrator to Platform for centralized observability.
 *
 * Schema bounds are the first line of defence against pollution of the
 * Platform's monitoring system: a malformed or hostile push fails Zod
 * parse at the WS edge and never reaches the aggregator or the Mimir
 * relay. The content-level allow-list (catalog) is enforced one step
 * deeper — see `packages/platform/src/ws/metrics-filter.ts`.
 *
 * Caps:
 * - 2000 metric data points per push (one orch ships ~60 today)
 * - 128-char metric name, 64-char label key, 256-char label value
 * - 15 labels per series (KiCI metrics carry ~5 today)
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

/**
 * Acknowledgment that a webhook was received and processing started.
 *
 * Under the chunked relay protocol the orchestrator also reports the HMAC
 * verification outcome here via `result`, and may include a non-secret-bearing
 * diagnostic in `reason` when result is a rejection. Both fields are optional
 * for backward compatibility during the rollout: pre-cutover senders omit them.
 */
export const webhookAckSchema = z.object({
  type: z.literal('webhook.ack'),
  messageId: z.string(),
  deliveryId: z.string(),
  /**
   * Verification + processing outcome. Required from the chunked relay path
   * (commit 3 onwards on the orch side); pre-chunked acks omit this.
   */
  result: WebhookRelayResult.optional(),
  /**
   * Optional non-secret-bearing diagnostic for rejection cases. MUST NOT
   * include any secret material (HMAC keys, bearer tokens, computed signatures).
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
});

/** Cache lookup statistics forwarded from orchestrator to Platform for centralized metrics. */
export const cacheStatsSchema = z.object({
  type: z.literal('cache.stats'),
  cacheType: z.enum(['source', 'dep']),
  hit: z.boolean(),
});
export type CacheStats = z.infer<typeof cacheStatsSchema>;

/**
 * Runtime broadcast of an updated dashboard-write policy. Carries the
 * orch's full capabilities object (same shape as `orchCapabilitiesSchema`
 * via `auth.request`) so Platform's per-org cache can be replaced
 * wholesale rather than merged. Emitted by the orch whenever an
 * operator flips a switch via `kici-admin org-settings dashboard-writes`;
 * Platform receives it, updates its cache, and re-broadcasts the
 * relevant subset to any connected dashboard SPA sessions.
 */
export const orchCapabilitiesUpdateSchema = z.object({
  type: z.literal('orch.capabilities.update'),
  capabilities: orchCapabilitiesSchema,
});
export type OrchCapabilitiesUpdate = z.infer<typeof orchCapabilitiesUpdateSchema>;

// --- Direction-specific discriminated unions ---

/** All messages that flow from Platform to Orchestrator.
 *
 * The single-frame `webhookRelaySchema` is intentionally NOT a member of this
 * union: that shape carries an attacker-controlled `payload` and pre-existed
 * the chunked relay's on-orch HMAC verification, so accepting it on the wire
 * would let a compromised Platform (A10) fabricate webhook deliveries that
 * bypass the only trust boundary against a malicious Platform (see the
 * docblock on `webhookRelaySchema` above and migration
 * `packages/platform/src/db/migrations/012_drop_webhook_secret_columns.ts`).
 * The chunked path `webhook.relay.start` + `webhook.relay.chunk` is the sole
 * legitimate route from Platform to `onWebhookRelay`. */
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
  // Every dashboard request the Platform can proxy to the orchestrator.
  // Derived from the dashboard-direction union so the two can never drift:
  // a dashboard request type absent from this wire union is silently
  // dropped by the orchestrator's frame parser and surfaces only as a
  // dashboard proxy timeout.
  ...dashboardPlatformToOrchSchema.options,
]);

/** All messages that flow from Orchestrator to Platform.
 *
 * Note: Dashboard response messages (dashboard.run.detail.response,
 * dashboard.step.logs.response, dashboard.orch.logs.response) are intentionally
 * excluded here. They are parsed separately via dashboardOrchToPlatformSchema so
 * the Platform WS handler can route them to the DashboardProxy for request
 * correlation. */
export const orchestratorToPlatformMessageSchema = z.discriminatedUnion('type', [
  webhookAckSchema,
  executionEventSchema,
  logChunkSchema,
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
]);

// --- Inferred types ---

export type WebhookRelay = z.infer<typeof webhookRelaySchema>;
export type WebhookAck = z.infer<typeof webhookAckSchema>;
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type LogChunk = z.infer<typeof logChunkSchema>;
export type PeerDiscover = z.infer<typeof peerDiscoverSchema>;
export type PeerUpdate = z.infer<typeof peerUpdateSchema>;
export type PlatformToOrchestratorMessage = z.infer<typeof platformToOrchestratorMessageSchema>;
export type OrchestratorToPlatformMessage = z.infer<typeof orchestratorToPlatformMessageSchema>;
// Note: ExecutionStatus and StepStatusForward types are exported from execution-status.ts.
// Do not re-export here to avoid duplicate type definitions.
