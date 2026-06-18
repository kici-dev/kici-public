import { z } from 'zod';
import { ExecutionJobStatus } from './execution-status.js';
import { ScalerEventType } from './scaler-event.js';
import { LabelMatcher } from '../../labels-match.js';

// --- Peer-to-peer protocol messages ---
// Used for direct communication between orchestrator instances in a cluster.
// Covers authentication, heartbeat, job rerouting, progress, cancel, and Raft consensus.

// --- Capability sub-schemas (shared by auth response and heartbeat) ---

/** Agent summary included in peer heartbeat and auth response messages. */
const peerAgentSummarySchema = z.object({
  agentId: z.string(),
  labels: z.array(z.string()),
  activeJobs: z.number(),
  maxConcurrency: z.number(),
  platform: z.string(),
  arch: z.string(),
  /**
   * Kubernetes-taint-style mandatory labels inherited from the spawning
   * scaler (empty / omitted for static agents and warm-pool replenishment
   * spawns). Cross-peer routing applies the same gate the local label
   * matcher does: a connected-agent entry only matches when every
   * mandatory label appears in the required label set.
   *
   * Optional + default `[]` for legacy peers — older orchestrators that
   * predate the gate omit the field, and the coordinator falls back to
   * "no gate" routing for those agents (matching pre-gate behavior).
   */
  mandatoryLabels: z.array(z.string()).optional().default([]),
  /**
   * Name of the scaler backend that spawned this agent, or null/omitted for
   * static (stateful) agents not bound to any scaler. Carried so the dashboard
   * diagnostics tree can group a worker peer's agents under the correct scaler
   * row (and the stateful-agents row) without a second round trip.
   */
  scalerName: z.string().nullable().optional(),
});

/** Peer capabilities advertised during heartbeat and auth response. */
export const peerCapabilitiesSchema = z.object({
  s3LogAccess: z.boolean(),
  logRoutingOverride: z.enum(['direct', 'coordinator']).optional(),
});

/** Scaler capacity summary included in peer heartbeat and auth response for routing decisions. */
const scalerCapacitySummarySchema = z.object({
  /** Scaler backend name (e.g. "stg-worker-bare-metal") */
  name: z.string().optional(),
  /** Scaler backend type (e.g. "bare-metal", "container") */
  type: z.string().optional(),
  /** Label sets this scaler backend can provision */
  labelSets: z.array(z.array(z.string())),
  /** Maximum agents for this backend */
  maxAgents: z.number(),
  /** Current active count for this backend */
  activeCount: z.number(),
  /**
   * Whether this backend spawns its agents on the peer's own host (bare-metal,
   * Firecracker, container on a local runtime socket). Lets diagnostics
   * surface the peer's hostname as the scaler's spawning host.
   */
  spawnsOnLocalHost: z.boolean().optional(),
  /**
   * Labels a job MUST declare in `runsOn` to be allowed on this backend
   * (Kubernetes-taint-style opt-in gate). When omitted (legacy peer) or
   * empty the backend has no gate. Cross-peer routing applies the same
   * rule as the local label matcher: a scaler-capacity entry only
   * matches when every mandatory label appears in the required label set.
   */
  mandatoryLabels: z.array(z.string()).optional().default([]),
});

// --- ECDH handshake ---

/** Peer hello: initiator sends ephemeral X25519 public key and nonce. */
export const peerHelloSchema = z.object({
  type: z.literal('peer.hello'),
  /** Base64-encoded X25519 DER SPKI ephemeral public key. */
  ephemeralPublicKey: z.string(),
  /** Base64-encoded 32-byte random nonce (HKDF salt). */
  nonce: z.string(),
});

/** Peer hello response: responder sends their ephemeral X25519 public key. */
export const peerHelloResponseSchema = z.object({
  type: z.literal('peer.hello.response'),
  /** Base64-encoded X25519 DER SPKI ephemeral public key. */
  ephemeralPublicKey: z.string(),
});

// --- Peer authentication ---

/** Peer auth request sent after ECDH handshake (encrypted channel established). */
export const peerAuthRequestSchema = z.object({
  type: z.literal('peer.auth.request'),
  instanceId: z.string(),
  /** Join token (first connection via token-based auth). */
  token: z.string().optional(),
  /** HMAC proof of credential ownership (reconnection). */
  proof: z.string().optional(),
  protocolVersion: z.number(),
  /** Software version of the connecting peer (for version compat check). */
  softwareVersion: z.string().optional(),
  /** Role of the connecting peer. */
  role: z.enum(['coordinator', 'worker']).optional(),
});

/** Peer auth response indicating whether the connection was accepted. */
export const peerAuthResponseSchema = z.object({
  type: z.literal('peer.auth.response'),
  accepted: z.boolean(),
  instanceId: z.string().optional(),
  reason: z.string().optional(),
  /** Session credential issued on first join (worker stores for reconnection). */
  sessionCredential: z.string().optional(),
  /** Assigned role echoed back to the connecting peer. */
  role: z.string().optional(),
  /** Software version of the coordinator (for version compat check). */
  softwareVersion: z.string().optional(),
  // Capabilities included when accepted=true (optional for backward compat)
  agents: z.array(peerAgentSummarySchema).optional(),
  scalerCapacity: z.array(scalerCapacitySummarySchema).optional(),
  capabilities: peerCapabilitiesSchema.optional(),
});

// --- Peer heartbeat ---

/** Periodic heartbeat from one orchestrator to its peers. */
export const peerHeartbeatSchema = z.object({
  type: z.literal('peer.heartbeat'),
  instanceId: z.string(),
  term: z.number(),
  leaderId: z.string().nullable(),
  draining: z.boolean(),
  agents: z.array(peerAgentSummarySchema),
  capabilities: peerCapabilitiesSchema,
  /** Optional scaler capacity data for on-demand backends (backward compatible). */
  scalerCapacity: z.array(scalerCapacitySummarySchema).optional(),
  /** Shared config version for cross-orchestrator config sync (backward compatible). */
  configVersion: z.number().optional(),
  /** Registry version for cross-orchestrator registration sync (backward compatible). */
  registryVersion: z.number().optional(),
  timestamp: z.number(),
  // --- OS metadata (optional, for diagnostics visibility) ---
  hostname: z.string().optional(),
  osRelease: z.string().optional(),
  totalMemoryMb: z.number().optional(),
  memoryUsedMb: z.number().optional(),
  memoryAvailableMb: z.number().optional(),
  cpuCount: z.number().optional(),
  uptimeSeconds: z.number().optional(),
  nodeVersion: z.string().optional(),
  runningAsUser: z.string().nullable().optional(),
  runningAsUid: z.number().nullable().optional(),
  version: z.string().optional(),
});

// --- Job rerouting ---

/** Request to reroute a job to another orchestrator (no local agent can handle it). */
export const jobRerouteSchema = z.object({
  type: z.literal('job.reroute'),
  messageId: z.string(),
  /**
   * Pre-allocated job identifier. The sending coordinator MUST allocate
   * the jobId before sending so it can register the execution_runs +
   * execution_jobs rows under that id in its own DB. Receiving peer
   * (worker or coord) MUST use this exact id when dispatching to its
   * agent — without that, the agent's later `job.status`/`step.status`
   * messages reference a jobId the owning coord never wrote to the DB,
   * and the run silently stalls at `running`.
   */
  jobId: z.string(),
  runId: z.string(),
  deliveryId: z.string(),
  routingKey: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  jobName: z.string(),
  workflowName: z.string(),
  runsOnLabels: z.array(z.array(z.string())),
  /** Labels that the dispatched agent must NOT have (optional for backward compatibility). */
  excludeLabels: z.array(z.string()).optional(),
  /**
   * Glob/regex include matchers the receiving peer's agent labels must
   * satisfy (JS post-filter, applied on top of the exact `runsOnLabels`
   * prefilter — same semantics as the single-orchestrator dispatch path).
   * Absent is treated as `[]`. A pure-pattern job (no exact labels) carries
   * its selector here; dropping it would let the job match any local agent.
   */
  runsOnPatterns: z.array(LabelMatcher).optional(),
  /** Glob/regex matchers that disqualify a candidate agent (JS post-filter). Absent is `[]`. */
  excludePatterns: z.array(LabelMatcher).optional(),
  triedConnections: z.array(z.string()),
  maxHops: z.number(),
  coordinatorId: z.string(),
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  /** Resolved job configuration (steps, rules, matrix, etc.) for the receiving orch to dispatch. */
  jobConfig: z.record(z.string(), z.unknown()).optional(),
  /** Clone URL for the repository. */
  repoUrl: z.string().optional(),
  /** Git ref (branch name). */
  ref: z.string().optional(),
  /** Commit SHA. */
  sha: z.string().optional(),
  /** Provider type (e.g. 'github'). */
  provider: z.string().optional(),
  /** Provider-specific context (e.g. { installationId }). */
  providerContext: z.record(z.string(), z.unknown()).optional(),
  /** Pre-signed source tarball download URL (cache hit). */
  sourceTarUrl: z.string().optional(),
  /** SHA-256 hash of the source tarball bytes for integrity verification. */
  sourceTarHash: z.string().optional(),
  /** Pre-signed dependency tarball download URL (cache hit). */
  depsUrl: z.string().optional(),
  /** Dependency tarball hash for cache keying. */
  depsHash: z.string().optional(),
  /** Pre-resolved clone token for workers without provider credentials. */
  cloneToken: z.string().optional(),
  /** Encrypted secrets envelope (AES-256-GCM with session key). */
  encryptedSecrets: z.string().optional(),
  /** Encrypted namespaced secrets envelope. */
  encryptedNamespacedSecrets: z.string().optional(),
});

/** Acknowledgment of a job reroute request. */
export const jobRerouteAckSchema = z.object({
  type: z.literal('job.reroute.ack'),
  messageId: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});

// --- Job progress and cancel (peer-to-peer) ---

/**
 * Job or step progress update forwarded from a worker peer to its owning
 * coordinator (the coord that has the run rows in its DB).
 *
 * `kind` is the discriminator the coord uses to decide which downstream
 * call to make:
 *  - kind='job'  → ExecutionTracker.onJobStatus, which is what drives the
 *                  run-level state machine (running → success/failed/...).
 *                  `stepIndex`/`stepName` are unused for this kind.
 *  - kind='step' → ExecutionTracker.onStepStatus, which only persists step
 *                  rows. `stepIndex`/`stepName` MUST point at the step.
 *
 * Without the discriminator, the coord conflated the two and silently
 * dropped every job-level event into onStepStatus, so the run never
 * advanced past `running` for a peer-rerouted job.
 *
 * `state` is typed as the full ExecutionJobStatus enum because the worker
 * forwards the agent's job.status verbatim; ExecutionStepStatus is a
 * strict subset and the coord trusts `kind` to route correctly.
 */
export const jobProgressSchema = z.object({
  type: z.literal('job.progress'),
  kind: z.enum(['job', 'step']),
  runId: z.string(),
  jobId: z.string(),
  jobName: z.string(),
  stepIndex: z.number(),
  stepName: z.string(),
  state: ExecutionJobStatus,
  timestamp: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Request to cancel a job on a peer orchestrator. */
export const peerJobCancelSchema = z.object({
  type: z.literal('peer.job.cancel'),
  runId: z.string(),
  jobId: z.string().optional(),
  reason: z.string(),
  /** When true, force-cancel immediately without waiting for hooks. */
  force: z.boolean().optional(),
});

// --- Raft consensus ---

/** Raft vote request during leader election. */
export const raftVoteRequestSchema = z.object({
  type: z.literal('raft.vote.request'),
  term: z.number(),
  candidateId: z.string(),
  lastLogIndex: z.number(),
  lastLogTerm: z.number(),
});

/** Raft vote response from a peer. */
export const raftVoteResponseSchema = z.object({
  type: z.literal('raft.vote.response'),
  term: z.number(),
  voteGranted: z.boolean(),
  voterId: z.string(),
});

/** Raft append entries (leader heartbeat only, no log entries). */
export const raftAppendEntriesSchema = z.object({
  type: z.literal('raft.append.entries'),
  term: z.number(),
  leaderId: z.string(),
});

// --- Log and cache relay (coordinator-worker topology) ---

/** Log chunk relay: worker -> coordinator. Batched log lines from agent execution. */
const peerLogChunkSchema = z.object({
  type: z.literal('peer.log.chunk'),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  lines: z.array(
    z.object({
      text: z.string(),
      timestamp: z.number(),
      stream: z.enum(['stdout', 'stderr']).optional(),
    }),
  ),
});

/** Cache upload request: worker -> coordinator. Worker agent needs upload URL. */
const peerCacheUploadRequestSchema = z.object({
  type: z.literal('peer.cache.upload.request'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  cacheType: z.enum(['source', 'deps']),
  hash: z.string(),
  sizeBytes: z.number(),
});

/** Cache upload response: coordinator -> worker. Pre-signed upload URL. */
const peerCacheUploadResponseSchema = z.object({
  type: z.literal('peer.cache.upload.response'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  uploadUrl: z.string(),
});

// --- Config reload (per-instance targeting) ---

/**
 * Config reload request: forwarded from one orchestrator to a specific peer
 * when an operator calls POST /admin/config/reload with a `target` parameter.
 * The receiving peer executes a local reload and replies with
 * peer.config.reload.response.
 */
export const peerConfigReloadSchema = z.object({
  type: z.literal('peer.config.reload'),
  messageId: z.string(),
  /** Whether to drain in-flight work before reloading. */
  drain: z.boolean().optional(),
});

/**
 * Config reload response: sent back from the target peer carrying the
 * ReloadResult fields produced by ConfigReloader.executeReload().
 */
export const peerConfigReloadResponseSchema = z.object({
  type: z.literal('peer.config.reload.response'),
  messageId: z.string(),
  success: z.boolean(),
  version: z.number().optional(),
  errors: z.array(z.string()).optional(),
  restartRequired: z.array(z.string()).optional(),
  fieldsChanged: z.array(z.string()).optional(),
});

// --- Fleet log collection (orchestrator → peer subtree request / peer → orchestrator chunked response) ---

/** Which of THIS peer's downstream nodes to gather. all=true ignores the id lists. */
export const fleetSelectionSchema = z.object({
  all: z.boolean(),
  agentIds: z.array(z.string()).default([]),
  workerInstanceIds: z.array(z.string()).default([]),
});

/** Ask a peer to assemble and stream back its subtree bundle. */
export const peerLogsCollectRequestSchema = z.object({
  type: z.literal('peer.logs.collect.request'),
  messageId: z.string(),
  logWindowHours: z.number(),
  /** Loop guard: false on every downstream request so the coordinator mesh never echoes. */
  includeCoordinatorMesh: z.boolean(),
  selection: fleetSelectionSchema,
});

/** One base64 frame of a peer's subtree ZIP. */
export const peerLogsCollectChunkSchema = z.object({
  type: z.literal('peer.logs.collect.chunk'),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
  isLast: z.boolean(),
  dataB64: z.string(),
});

/** Peer failed to assemble/stream its subtree. */
export const peerLogsCollectErrorSchema = z.object({
  type: z.literal('peer.logs.collect.error'),
  messageId: z.string(),
  message: z.string(),
});

// --- Graceful shutdown announcement ---

/** Graceful shutdown announcement. Peers remove sender from registry immediately. */
export const peerLeavingSchema = z.object({
  type: z.literal('peer.leaving'),
  instanceId: z.string(),
  /** Current Raft term for leader identification */
  term: z.number(),
});

// --- Cross-peer agent-token revoke fan-out ---

/**
 * Notify every peer that an agent token has been revoked so each peer can
 * close its own in-flight WS connections authenticated by that token.
 * The originating peer kicks locally first (via the DELETE admin route),
 * then broadcasts this message over the encrypted peer mesh.
 */
export const peerAgentTokenRevokeSchema = z.object({
  type: z.literal('peer.agent-token.revoke'),
  /** The `agent_tokens.id` whose in-flight WS must be kicked on every peer. */
  tokenId: z.string().min(1),
  /** Originating peer's instanceId — for log correlation across the cluster. */
  senderInstanceId: z.string().min(1),
});

// --- Scaler provisioning events ---

/**
 * A scaler provisioning event a worker forwards to the owning coordinator.
 *
 * Workers have no database, so they cannot persist a provisioning failure
 * themselves. When a worker's scaler emits an event correlated to a queued
 * job (e.g. a failed agent spawn), the worker relays it to the coordinator
 * that owns the run; the coordinator's ExecutionTracker writes it to the
 * provisioning log and the dispatch queue's last-error column.
 */
export const peerScalerEventSchema = z.object({
  type: z.literal('scaler.event'),
  runId: z.string(),
  jobId: z.string(),
  /** The scaler-managed agent id the event is about. */
  agentId: z.string(),
  /** Scaler event type (one of the ScalerEventType enum members). */
  eventType: ScalerEventType,
  /** Human-readable detail, including any captured spawn stderr tail. */
  detail: z.string(),
  /** Event timestamp in epoch milliseconds. */
  timestampMs: z.number(),
});

// --- Discriminated unions ---

/** All peer-to-peer messages (outbound from this node). */
export const peerToPeerMessageSchema = z.discriminatedUnion('type', [
  peerHelloSchema,
  peerHelloResponseSchema,
  peerAuthRequestSchema,
  peerAuthResponseSchema,
  peerHeartbeatSchema,
  jobRerouteSchema,
  jobRerouteAckSchema,
  jobProgressSchema,
  peerJobCancelSchema,
  raftVoteRequestSchema,
  raftVoteResponseSchema,
  raftAppendEntriesSchema,
  peerLogChunkSchema,
  peerCacheUploadRequestSchema,
  peerCacheUploadResponseSchema,
  peerConfigReloadSchema,
  peerConfigReloadResponseSchema,
  peerLogsCollectRequestSchema,
  peerLogsCollectChunkSchema,
  peerLogsCollectErrorSchema,
  peerLeavingSchema,
  peerAgentTokenRevokeSchema,
  peerScalerEventSchema,
]);

/** All peer-to-peer messages (inbound to this node). */
export const peerFromPeerMessageSchema = z.discriminatedUnion('type', [
  peerHelloSchema,
  peerHelloResponseSchema,
  peerAuthRequestSchema,
  peerAuthResponseSchema,
  peerHeartbeatSchema,
  jobRerouteSchema,
  jobRerouteAckSchema,
  jobProgressSchema,
  peerJobCancelSchema,
  raftVoteRequestSchema,
  raftVoteResponseSchema,
  raftAppendEntriesSchema,
  peerLogChunkSchema,
  peerCacheUploadRequestSchema,
  peerCacheUploadResponseSchema,
  peerConfigReloadSchema,
  peerConfigReloadResponseSchema,
  peerLogsCollectRequestSchema,
  peerLogsCollectChunkSchema,
  peerLogsCollectErrorSchema,
  peerLeavingSchema,
  peerAgentTokenRevokeSchema,
  peerScalerEventSchema,
]);

// --- Inferred types ---

export type PeerCapabilities = z.infer<typeof peerCapabilitiesSchema>;
export type ScalerCapacitySummary = z.infer<typeof scalerCapacitySummarySchema>;
export type PeerHeartbeat = z.infer<typeof peerHeartbeatSchema>;
export type JobReroute = z.infer<typeof jobRerouteSchema>;
export type JobProgress = z.infer<typeof jobProgressSchema>;
export type PeerScalerEvent = z.infer<typeof peerScalerEventSchema>;
export type PeerJobCancel = z.infer<typeof peerJobCancelSchema>;
export type RaftVoteRequest = z.infer<typeof raftVoteRequestSchema>;
export type RaftVoteResponse = z.infer<typeof raftVoteResponseSchema>;
export type RaftAppendEntries = z.infer<typeof raftAppendEntriesSchema>;
export type PeerLogChunk = z.infer<typeof peerLogChunkSchema>;
export type PeerCacheUploadRequest = z.infer<typeof peerCacheUploadRequestSchema>;
export type PeerCacheUploadResponse = z.infer<typeof peerCacheUploadResponseSchema>;
export type PeerConfigReload = z.infer<typeof peerConfigReloadSchema>;
export type PeerConfigReloadResponse = z.infer<typeof peerConfigReloadResponseSchema>;
export type PeerLeaving = z.infer<typeof peerLeavingSchema>;
export type PeerAgentTokenRevoke = z.infer<typeof peerAgentTokenRevokeSchema>;
export type FleetSelection = z.infer<typeof fleetSelectionSchema>;
export type PeerLogsCollectRequest = z.infer<typeof peerLogsCollectRequestSchema>;
export type PeerLogsCollectChunk = z.infer<typeof peerLogsCollectChunkSchema>;
export type PeerLogsCollectError = z.infer<typeof peerLogsCollectErrorSchema>;
export type PeerToPeerMessage = z.infer<typeof peerToPeerMessageSchema>;
