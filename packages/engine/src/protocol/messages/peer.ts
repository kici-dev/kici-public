import { z } from 'zod';
import { ExecutionJobStatus } from './execution-status.js';
import { LogStream } from './log-stream.js';
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
   * scaler. Always sent: a static agent and a warm-pool replenishment spawn
   * carry `[]`, which is "no gate". Cross-peer routing applies the same gate
   * the local label matcher does: a connected-agent entry only matches when
   * every mandatory label appears in the required label set.
   */
  mandatoryLabels: z.array(z.string()),
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

/**
 * Scaler capacity summary included in peer heartbeat and auth response for
 * routing decisions. `.strict()`: the entry once carried a scaler-wide taint
 * union a peer on this protocol floor never sends, so a stray field is a
 * version-skew signal rather than something to ignore.
 */
const scalerCapacitySummarySchema = z
  .object({
    /** Scaler backend name (e.g. "worker-bare-metal") */
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
     * Per-label-set taint gate (Kubernetes-taint-style opt-in), index-aligned
     * with `labelSets`: entry `i` is the set of labels a job MUST declare in
     * `runsOn` to route to `labelSets[i]`; an empty entry means that set has no
     * gate. Cross-peer routing applies the same rule as the local label matcher.
     * A consumer refuses to route through an entry whose length does not equal
     * `labelSets.length`, so a malformed advertisement is never indexed into.
     */
    labelSetMandatoryLabels: z.array(z.array(z.string())),
  })
  .strict();

// --- ECDH handshake ---

/** Peer authentication schemes. A server lists the ones it accepts in `peer.hello`. */
export const PeerAuthScheme = z.enum(['mutual-v2']);
export type PeerAuthScheme = z.infer<typeof PeerAuthScheme>;

/** How a peer proves itself: with its persisted credential, or with a join token on first join. */
export const PeerAuthMode = z.enum(['credential', 'token']);
export type PeerAuthMode = z.infer<typeof PeerAuthMode>;

/**
 * The reason a server gives a peer that authenticates without mutual-v2 (a
 * proof or token field, or no scheme). It is none of the credential-divergence
 * reasons, so that peer keeps its credential file.
 */
export const PEER_MUTUAL_AUTH_REQUIRED_REASON = 'Mutual peer authentication required';

/** Peer hello: the server sends its ephemeral X25519 public key, a nonce and its schemes. */
export const peerHelloSchema = z.object({
  type: z.literal('peer.hello'),
  /** Base64-encoded X25519 DER SPKI ephemeral public key. */
  ephemeralPublicKey: z.string(),
  /** Base64-encoded 32-byte random nonce (HKDF salt). */
  nonce: z.string(),
  /**
   * The authentication schemes this server accepts. Strings rather than an
   * enum, so a hello naming a scheme this build does not know still parses.
   * Optional so a hello naming none reaches the client's explicit refusal.
   */
  authSchemes: z.array(z.string()).optional(),
});

/** Peer hello response: responder sends their ephemeral X25519 public key. */
export const peerHelloResponseSchema = z.object({
  type: z.literal('peer.hello.response'),
  /** Base64-encoded X25519 DER SPKI ephemeral public key. */
  ephemeralPublicKey: z.string(),
});

// --- Peer authentication (mutual-v2) ---
// Both messages travel under the handshake key. The client proves the shared
// key (its credential, or its join token) with an HMAC over the handshake
// transcript; the server answers with its own HMAC over the transcript and the
// client proof. The client accepts nothing until that server proof verifies,
// and every later frame uses an application key derived from the shared key.

/** Peer auth request sent after the ECDH handshake, under the handshake key. */
export const peerAuthRequestSchema = z.object({
  type: z.literal('peer.auth.request'),
  instanceId: z.string(),
  protocolVersion: z.number(),
  /** Software version of the connecting peer (logged). */
  softwareVersion: z.string().optional(),
  /** Role of the connecting peer, as it declares it. */
  role: z.enum(['coordinator', 'worker']).optional(),
  scheme: PeerAuthScheme,
  mode: PeerAuthMode,
  /** Hex HMAC-SHA256 proof bound to the handshake transcript. */
  clientProof: z.string(),
  /** The join token's base64url routing segment. The server requires it in token mode. */
  tokenRouting: z.string().optional(),
});

/** Peer auth response indicating whether the connection was accepted. */
export const peerAuthResponseSchema = z.object({
  type: z.literal('peer.auth.response'),
  accepted: z.boolean(),
  instanceId: z.string().optional(),
  reason: z.string().optional(),
  /** Hex proof that the server holds the same credential or token; present on every acceptance. */
  serverProof: z.string().optional(),
  /** Session credential issued on first join (worker stores for reconnection). */
  sessionCredential: z.string().optional(),
  /** Assigned role echoed back to the connecting peer. */
  role: z.string().optional(),
  /** Software version of the coordinator (for version compat check). */
  softwareVersion: z.string().optional(),
  // Capabilities included when accepted=true
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
  /** Scaler capacity data for on-demand backends. */
  scalerCapacity: z.array(scalerCapacitySummarySchema).optional(),
  /** Shared config version for cross-orchestrator config sync. */
  configVersion: z.number().optional(),
  /** Registry version for cross-orchestrator registration sync. */
  registryVersion: z.number().optional(),
  /** Cluster-settings version for the coordinator→worker settings pull. */
  clusterSettingsVersion: z.number().optional(),
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

/**
 * The spawn-retry budget a worker applies to one rerouted job: how many agent
 * spawns it attempts, and how long it waits after a failed one. The sending
 * coordinator resolves it per org and enforces the same budget on its side.
 */
export const rerouteSpawnRetrySchema = z.object({
  maxAttempts: z.number().int().min(1),
  backoffMs: z.number().int().min(0),
});

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
  /** Labels that the dispatched agent must NOT have. Absent is `[]`. */
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
  /** The worker's spawn-retry budget for this job. */
  spawnRetry: rerouteSpawnRetrySchema,
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
  /** SHA-256 of the source tarball's own bytes, for integrity verification. */
  sourceTarDigest: z.string().optional(),
  /** Pre-signed dependency tarball download URL (cache hit). */
  depsUrl: z.string().optional(),
  /** Dependency tarball hash for cache keying. */
  depsHash: z.string().optional(),
  /** Pre-resolved clone token for workers without provider credentials. */
  cloneToken: z.string().optional(),
  /** Pre-resolved clone token for the workflow repository of an organization-wide job. */
  workflowCloneToken: z.string().optional(),
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

/**
 * Acknowledgement sent coordinator -> worker once the coordinator has applied
 * a terminal `job.progress` (kind='job') to its run/job DB rows. The worker
 * uses it to prune the matching record from its durable outbox. Carries
 * `state` for debuggability; `(runId, jobId)` is the dedup key.
 */
export const jobProgressAckSchema = z.object({
  type: z.literal('job.progress.ack'),
  runId: z.string(),
  jobId: z.string(),
  state: ExecutionJobStatus,
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
      stream: LogStream,
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

// --- Scaler reload (fan-out from the orchestrator that received it) ---

/**
 * What a scaler config reload did on one orchestrator. `rejected`: the file did
 * not load or validate, or an added scaler did not build, and nothing applied.
 * `not-configured`: the orchestrator runs without a scaler config, so there is
 * nothing to reload. `unreachable`: the request did not reach the orchestrator,
 * or it did not answer in time.
 */
export const ScalerReloadOutcome = z.enum(['applied', 'rejected', 'not-configured', 'unreachable']);
export type ScalerReloadOutcome = z.infer<typeof ScalerReloadOutcome>;

/**
 * What an applied scaler reload changed, as scaler names per bucket. `updated`
 * holds the kept scalers whose entry changed and `unchanged` the rest of them;
 * `global` names the changed top-level limits (`globalMaxAgents`,
 * `globalResourceCap`).
 */
export const scalerReloadPlanSchema = z.object({
  added: z.array(z.string()),
  updated: z.array(z.string()),
  unchanged: z.array(z.string()),
  retired: z.array(z.string()),
  resurrected: z.array(z.string()),
  global: z.array(z.string()),
});
export type ScalerReloadPlan = z.infer<typeof scalerReloadPlanSchema>;

/** One orchestrator's scaler reload outcome, its plan when applied, its errors when refused. */
export const scalerReloadAnswerSchema = z.object({
  outcome: ScalerReloadOutcome,
  plan: scalerReloadPlanSchema.optional(),
  errors: z.array(z.string()).optional(),
});
export type ScalerReloadAnswer = z.infer<typeof scalerReloadAnswerSchema>;

/** One orchestrator's answer to a scaler reload, as `kici-admin scaler reload` reports it. */
export const scalerReloadInstanceResultSchema = scalerReloadAnswerSchema.extend({
  instanceId: z.string(),
  role: z.enum(['coordinator', 'worker', 'unknown']),
  /** Why the outcome is what it is, for an instance that was not reached or did not answer. */
  detail: z.string().optional(),
});
export type ScalerReloadInstanceResult = z.infer<typeof scalerReloadInstanceResultSchema>;

/**
 * Scaler reload request: the orchestrator that received `kici-admin scaler
 * reload` asks each connected peer to re-read its own scaler config. The peer
 * answers with peer.scaler.reload.response.
 */
export const peerScalerReloadRequestSchema = z.object({
  type: z.literal('peer.scaler.reload.request'),
  messageId: z.string(),
});

/** Scaler reload response: the peer's outcome, its plan when applied, its errors when rejected. */
export const peerScalerReloadResponseSchema = scalerReloadAnswerSchema.extend({
  type: z.literal('peer.scaler.reload.response'),
  messageId: z.string(),
  detail: z.string().optional(),
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
  /** The target peer's scaler config reload outcome, when it runs a scaler config. */
  scaler: scalerReloadAnswerSchema.optional(),
});

// --- Scaler orphans (per-instance targeting) ---

/** How a live Firecracker VM relates to the orchestrator on its host. */
export const ScalerVmStatus = z.enum(['orphaned', 'unverified', 'tracked']);
export type ScalerVmStatus = z.infer<typeof ScalerVmStatus>;

/** What tracks a live VM. `bound-job` is answered from a coordinator's dispatch queue. */
export const ScalerVmTracker = z.enum(['backend', 'spawning', 'registered', 'bound-job']);
export type ScalerVmTracker = z.infer<typeof ScalerVmTracker>;

/** What a stop did to one VM. Only `stopped` signalled anything. */
export const ScalerVmStopOutcome = z.enum([
  'stopped',
  'tracked',
  'unverified',
  'not-live',
  'not-found',
  'error',
]);
export type ScalerVmStopOutcome = z.infer<typeof ScalerVmStopOutcome>;

/** What a scaler orphan request asks the target node to do. */
export const ScalerOrphansAction = z.enum(['list', 'stop']);
export type ScalerOrphansAction = z.infer<typeof ScalerOrphansAction>;

/** One live Firecracker VM on a node, as its orchestrator sees it. */
export const scalerLiveVmSchema = z.object({
  vmId: z.string(),
  scaler: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string(),
  ageSeconds: z.number().nonnegative(),
  chrootDir: z.string(),
  status: ScalerVmStatus,
  trackedBy: z.array(ScalerVmTracker),
  reason: z.string(),
});
export type ScalerLiveVm = z.infer<typeof scalerLiveVmSchema>;

/** The result of stopping one VM. `pid` is the process that was (or would be) signalled. */
export const scalerVmStopResultSchema = z.object({
  vmId: z.string(),
  outcome: ScalerVmStopOutcome,
  pid: z.number().int().positive().optional(),
  detail: z.string(),
});
export type ScalerVmStopResult = z.infer<typeof scalerVmStopResultSchema>;

/**
 * Scaler orphan request: forwarded by a coordinator to the node an operator
 * targeted with `kici-admin scaler orphans --target`. The node answers from
 * its own host and its own tracking with peer.scaler.orphans.response.
 */
export const peerScalerOrphansRequestSchema = z.object({
  type: z.literal('peer.scaler.orphans.request'),
  messageId: z.string(),
  action: ScalerOrphansAction,
  /** `stop` only: the VM ids the operator approved. */
  vmIds: z.array(z.string()).optional(),
});

/**
 * Scaler orphan response. `vms` answers a `list`, `results` answers a `stop`;
 * `ok: false` carries the node's `error` instead.
 */
export const peerScalerOrphansResponseSchema = z.object({
  type: z.literal('peer.scaler.orphans.response'),
  messageId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** The node's Firecracker scaler names; empty when it runs none. */
  firecrackerScalers: z.array(z.string()).optional(),
  vms: z.array(scalerLiveVmSchema).optional(),
  results: z.array(scalerVmStopResultSchema).optional(),
});

// --- Peer forget (fan-out from the coordinator that received it) ---

/**
 * What forgetting a departed peer did on one coordinator. `recent`: the peer
 * was heard from inside the window this coordinator still treats it as alive
 * for (the longer of the stale window and the reroute flap grace, or the
 * backstop grace of a peer that adopted provisions), so it may be partitioned
 * rather than gone. `acknowledgement-required`: forgetting it would switch this
 * coordinator's event-provision backstop back on, and the request did not
 * acknowledge that. Every outcome but `forgotten` keeps the peer.
 */
export const PeerForgetOutcome = z.enum([
  'forgotten',
  'not-found',
  'connected',
  'recent',
  'acknowledgement-required',
  'error',
]);
export type PeerForgetOutcome = z.infer<typeof PeerForgetOutcome>;

/**
 * Forget request: a coordinator that forgot a departed peer (`kici-admin peer
 * forget`) asks each connected sibling coordinator to drop it from its own
 * live peer registry too.
 */
export const peerForgetRequestSchema = z.object({
  type: z.literal('peer.forget.request'),
  messageId: z.string(),
  /** The departed peer's instance id. */
  instanceId: z.string(),
  /**
   * The operator acknowledged that forgetting the peer may switch the
   * event-provision backstop back on. Absent means not acknowledged.
   */
  acknowledgeBackstop: z.boolean().optional(),
});

/** Forget response: what the sibling did with the request. */
export const peerForgetResponseSchema = z.object({
  type: z.literal('peer.forget.response'),
  messageId: z.string(),
  outcome: PeerForgetOutcome,
  detail: z.string(),
});

/**
 * Worker-relevant cluster settings a DB-less worker pulls from a coordinator.
 *
 * A typed, concrete snapshot (not an open key/value bus): each worker-consumed
 * cluster knob is a field here. Adding the next worker-relevant knob is one
 * field on this schema, not a new protocol message.
 */
export const workerClusterSettingsSchema = z.object({
  agentTokenTtlMs: z.number(),
  /** How long a Firecracker spawn waits for the VM's API socket. */
  firecrackerApiSocketWaitMs: z.number(),
  /**
   * The concurrency-slot wait timeout a worker sends on each `job.dispatch`,
   * from `cluster_settings.concurrency_wait_timeout_ms`.
   */
  concurrencyWaitTimeoutMs: z.number(),
});

/**
 * Cluster-settings pull request: a DB-less worker asks a connected coordinator
 * for the current worker-settings snapshot after a coordinator advertised a
 * clusterSettingsVersion ahead of its own. The coordinator replies with
 * peer.clusterSettings.response.
 */
export const peerClusterSettingsRequestSchema = z.object({
  type: z.literal('peer.clusterSettings.request'),
  messageId: z.string(),
});

/**
 * Cluster-settings pull response: the coordinator resolves the snapshot from
 * cluster_settings and replies with it plus the current version.
 */
export const peerClusterSettingsResponseSchema = z.object({
  type: z.literal('peer.clusterSettings.response'),
  messageId: z.string(),
  version: z.number(),
  settings: workerClusterSettingsSchema,
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
  /**
   * The worker's retry verdict on a `scaler.failed` for a job under its spawn-retry
   * budget: false while attempts remain, true on the last one. Absent on a repeated
   * report of one failed spawn and on every other relay; the coordinator then keeps
   * its spawn window running unchanged.
   */
  final: z.boolean().optional(),
});

// --- Discriminated unions ---

/**
 * Every peer message type. Both directions carry the same set: each node sends
 * and receives every type, so one list backs both unions.
 */
const peerMessageSchemas = [
  peerHelloSchema,
  peerHelloResponseSchema,
  peerAuthRequestSchema,
  peerAuthResponseSchema,
  peerHeartbeatSchema,
  jobRerouteSchema,
  jobRerouteAckSchema,
  jobProgressSchema,
  jobProgressAckSchema,
  peerJobCancelSchema,
  raftVoteRequestSchema,
  raftVoteResponseSchema,
  raftAppendEntriesSchema,
  peerLogChunkSchema,
  peerCacheUploadRequestSchema,
  peerCacheUploadResponseSchema,
  peerConfigReloadSchema,
  peerConfigReloadResponseSchema,
  peerScalerOrphansRequestSchema,
  peerScalerOrphansResponseSchema,
  peerScalerReloadRequestSchema,
  peerScalerReloadResponseSchema,
  peerForgetRequestSchema,
  peerForgetResponseSchema,
  peerClusterSettingsRequestSchema,
  peerClusterSettingsResponseSchema,
  peerLogsCollectRequestSchema,
  peerLogsCollectChunkSchema,
  peerLogsCollectErrorSchema,
  peerLeavingSchema,
  peerAgentTokenRevokeSchema,
  peerScalerEventSchema,
] as const;

/** All peer-to-peer messages (outbound from this node). */
export const peerToPeerMessageSchema = z.discriminatedUnion('type', peerMessageSchemas);

/** All peer-to-peer messages (inbound to this node). */
export const peerFromPeerMessageSchema = z.discriminatedUnion('type', peerMessageSchemas);

// --- Inferred types ---

export type PeerCapabilities = z.infer<typeof peerCapabilitiesSchema>;
export type ScalerCapacitySummary = z.infer<typeof scalerCapacitySummarySchema>;
export type PeerHeartbeat = z.infer<typeof peerHeartbeatSchema>;
export type PeerHello = z.infer<typeof peerHelloSchema>;
export type PeerAuthRequest = z.infer<typeof peerAuthRequestSchema>;
export type PeerAuthResponse = z.infer<typeof peerAuthResponseSchema>;
export type JobReroute = z.infer<typeof jobRerouteSchema>;
export type RerouteSpawnRetry = z.infer<typeof rerouteSpawnRetrySchema>;
export type JobProgress = z.infer<typeof jobProgressSchema>;
export type JobProgressAck = z.infer<typeof jobProgressAckSchema>;
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
export type PeerScalerOrphansRequest = z.infer<typeof peerScalerOrphansRequestSchema>;
export type PeerScalerOrphansResponse = z.infer<typeof peerScalerOrphansResponseSchema>;
export type PeerScalerReloadRequest = z.infer<typeof peerScalerReloadRequestSchema>;
export type PeerScalerReloadResponse = z.infer<typeof peerScalerReloadResponseSchema>;
export type PeerForgetRequest = z.infer<typeof peerForgetRequestSchema>;
export type PeerForgetResponse = z.infer<typeof peerForgetResponseSchema>;
export type WorkerClusterSettings = z.infer<typeof workerClusterSettingsSchema>;
export type PeerClusterSettingsRequest = z.infer<typeof peerClusterSettingsRequestSchema>;
export type PeerClusterSettingsResponse = z.infer<typeof peerClusterSettingsResponseSchema>;
export type PeerLeaving = z.infer<typeof peerLeavingSchema>;
export type PeerAgentTokenRevoke = z.infer<typeof peerAgentTokenRevokeSchema>;
export type FleetSelection = z.infer<typeof fleetSelectionSchema>;
export type PeerLogsCollectRequest = z.infer<typeof peerLogsCollectRequestSchema>;
export type PeerLogsCollectChunk = z.infer<typeof peerLogsCollectChunkSchema>;
export type PeerLogsCollectError = z.infer<typeof peerLogsCollectErrorSchema>;
export type PeerToPeerMessage = z.infer<typeof peerToPeerMessageSchema>;
