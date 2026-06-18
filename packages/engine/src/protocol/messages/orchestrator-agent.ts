import { z } from 'zod';

import { approverClauseSchema } from '../../approval/types.js';
import { ExecutionJobStatus, ExecutionStepStatus } from './execution-status.js';

/**
 * Cache write scope for a job's user-facing cache.
 *
 * - `shared` — trusted ref (default branch / write-permission contributor):
 *   reads AND writes the org-shared default-branch scope.
 * - `isolated` — untrusted ref (fork PR / unknown contributor): reads the
 *   shared scope as a fallback but writes only into a per-run isolated scope,
 *   so an untrusted ref can never poison the shared cache (GitHub Actions model).
 */
export const CacheRefScope = z.enum(['shared', 'isolated']);
export type CacheRefScope = z.infer<typeof CacheRefScope>;

/**
 * Frozen snapshot of upstream job outputs for a result-aware dynamic generator.
 *
 * Captured once when the deferred eval job is dispatched (its upstreams are
 * terminal at that point) and replayed unchanged on agent-side re-eval, so the
 * generator sees the same `ctx.needs` data on both passes.
 *
 * - `jobs` maps an upstream job name to its outputs record.
 * - `groups` maps a dynamic group name to its ordered member job names.
 */
export const upstreamSnapshotSchema = z.object({
  jobs: z.record(z.string(), z.record(z.string(), z.unknown())),
  groups: z.record(z.string(), z.array(z.string())),
});
export type UpstreamSnapshot = z.infer<typeof upstreamSnapshotSchema>;

// --- Orchestrator -> Agent messages ---

/**
 * Structured git-clone auth material. Carries everything the agent needs to
 * authenticate a single `git clone`:
 *
 *   - `kind: 'basic'` — HTTPS Basic auth (PAT / password). `secret` is the
 *     token, `user` is the Basic-auth username (defaults filled in by the
 *     provider, e.g. `x-access-token` for GitHub-style PATs).
 *   - `kind: 'ssh'` — SSH key auth. `secret` is the PEM-encoded private key.
 *     `sshHostKeyPolicy` + `sshKnownHostsPem` drive StrictHostKeyChecking.
 *
 * Used by `sourceAuth` and `workflowAuth` on `jobDispatchSchema` so a single
 * global-workflow dispatch can carry two different credentials (one per
 * clone target — required for cross-provider global workflows).
 */
export const gitAuthSchema = z
  .object({
    kind: z.enum(['basic', 'ssh']),
    /** Basic-auth username. Omit for SSH. */
    user: z.string().optional(),
    /** Basic-auth password/PAT, or PEM-encoded SSH private key. */
    secret: z.string(),
    /** SSH-only. `accept-new` trusts first seen host keys; `pinned` requires `sshKnownHostsPem`. */
    sshHostKeyPolicy: z.enum(['accept-new', 'pinned']).optional(),
    /** SSH-only, required when `sshHostKeyPolicy === 'pinned'`. OpenSSH known_hosts content. */
    sshKnownHostsPem: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    // Mirror the agent-side guard in `setupSshAuth` (packages/agent/src/checkout/ssh-auth.ts):
    // pinned host-key checking with no known_hosts content is a misconfiguration that
    // would only surface at clone time. Reject at the protocol layer so a bad orchestrator
    // dispatch fails fast with a clear error instead of crashing the agent mid-job.
    if (val.kind === 'ssh' && val.sshHostKeyPolicy === 'pinned' && !val.sshKnownHostsPem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sshKnownHostsPem'],
        message: 'sshKnownHostsPem is required when sshHostKeyPolicy is "pinned"',
      });
    }
  });
export type GitAuth = z.infer<typeof gitAuthSchema>;

/** Dispatch a job to an agent for execution. */
export const jobDispatchSchema = z
  .object({
    type: z.literal('job.dispatch'),
    messageId: z.string(),
    runId: z.string(),
    jobId: z.string(),
    repoUrl: z.string(),
    ref: z.string(),
    sha: z.string(),
    lockFileUrl: z.string(),
    /** Pass-through job configuration. Shape is `LockJob | LockDynamicJobFn` from the lock file. */
    jobConfig: z
      .record(z.string(), z.unknown())
      .describe('Job configuration from the lock file (LockJob | LockDynamicJobFn)'),
    timestamp: z.number(),
    /** Short-lived GitHub installation token for private repo clone auth. */
    token: z.string().optional(),
    /** Orchestrator-provided secrets to merge into step environment. */
    secrets: z.record(z.string(), z.string()).optional(),
    /** Namespaced secrets by context name: { 'context-name': { KEY: 'value' } } */
    namespacedSecrets: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    /** Max log size per step in bytes. Agent falls back to its own config default (10MB). */
    maxLogSizeBytes: z.coerce.number().optional(),
    /** URL or file:// path to a pre-packed `.kici/` source tarball. If present, agent extracts it into workDir instead of cloning the repo. */
    sourceTarUrl: z.string().optional(),
    /** SHA-256 hash of the source tarball bytes for integrity verification on download. */
    sourceTarHash: z.string().optional(),
    /** URL or file:// path to pre-built dependency tarball. If present, agent extracts to .kici/node_modules/ instead of running install. */
    depsUrl: z.string().optional(),
    /** SHA-256 hash of the dependency tarball for integrity verification. */
    depsHash: z.string().optional(),
    /** Trace ID propagated across tiers for distributed tracing. */
    requestId: z.string().optional(),
    /** Base64-encoded X25519 public key for the workflow run (for encrypting secret outputs). */
    runPublicKey: z.string().optional(),
    /** Plain outputs from upstream jobs (keyed by job name, then by step name). Populated for downstream jobs with `needs` dependencies. */
    upstreamJobOutputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    /**
     * Structured clone auth for the source repo. Preferred over `token` (which
     * remains as a backward-compat field for same-provider GitHub App flows
     * during the transition to universal-git / cross-provider global workflows).
     *
     * When both `token` and `sourceAuth` are set, a Zod refinement enforces
     * that they agree (`sourceAuth.kind === 'basic'` and
     * `sourceAuth.secret === token`) — otherwise the dispatch is rejected to
     * prevent silent credential mismatches.
     */
    sourceAuth: gitAuthSchema.optional(),
    /**
     * Structured clone auth for the **workflow** repo in a global-workflow
     * dispatch (when the workflow is authored on a different source than the
     * source repo). When `jobConfig.isGlobalWorkflow === true` and the two
     * providers differ, the orchestrator populates `sourceAuth` from the
     * inbound bundle and `workflowAuth` from the registration's bundle.
     *
     * For same-provider global workflows this is typically absent and the
     * agent reuses `sourceAuth` for both clones.
     */
    workflowAuth: gitAuthSchema.optional(),
    /**
     * Private npm registries the agent should authenticate against before
     * `npm install`. Each entry's `token` is the resolved value (the
     * orchestrator already looked it up via the per-environment
     * secretResolver path; protection-rule gates have already passed at this
     * point). Untrusted contributors get an empty list.
     */
    npmRegistries: z
      .array(
        z.object({
          url: z.string().url(),
          scope: z.string().optional(),
          alwaysAuth: z.boolean(),
          token: z.string().min(1),
        }),
      )
      .optional(),
    /**
     * Extra resolved secrets to project as env vars on the install
     * subprocess. Keyed by the bare secret name (the qualified env: prefix
     * is stripped at resolution time). For use with a customer-committed
     * `.kici/.npmrc` containing `${VAR}` placeholders.
     */
    installEnvSecrets: z.record(z.string(), z.string()).optional(),
    /** Org id that owns this run — namespaces the user-facing cache (per-tenant isolation). */
    orgId: z.string().optional(),
    /** Repo identifier (e.g. "owner/repo") — second namespacing level for the user-facing cache. */
    repoId: z.string().optional(),
    /**
     * Cache write scope for this job. `shared` lets the job write the
     * org-shared default-branch cache; `isolated` confines writes to a
     * per-run scope while still allowing shared-scope reads. Absent ⇒ treated
     * as `isolated` by the agent (fail-closed).
     */
    cacheRefScope: CacheRefScope.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.token && val.sourceAuth) {
      if (val.sourceAuth.kind !== 'basic') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceAuth', 'kind'],
          message: 'token is set; sourceAuth.kind must be "basic" to agree',
        });
      } else if (val.sourceAuth.secret !== val.token) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceAuth', 'secret'],
          message: 'token and sourceAuth.secret must match when both are set',
        });
      }
    }
  });

/** Cancel a running or queued job. */
export const jobCancelSchema = z.object({
  type: z.literal('job.cancel'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  reason: z.string(),
  /** When true, force-cancel immediately without waiting for hooks. */
  force: z.boolean().optional(),
});

/** Acknowledge agent registration with orchestrator-assigned settings. */
export const registerAckSchema = z.object({
  type: z.literal('register.ack'),
  agentId: z.string(),
  labels: z.array(z.string()),
  scalerManaged: z.boolean().default(false),
  /**
   * Set when the orchestrator's scaler bound a specific queued job to this
   * agent at spawn time and is preparing the dispatch.job message right now.
   * Scaler-managed agents that see this flag MUST NOT arm the short
   * KICI_SCALER_IDLE_TIMEOUT timer on register — the dispatch is in flight
   * and may take a few seconds to arrive (provider lookup, secret merging,
   * upstream output fetching all happen between register.ack and dispatch.job
   * for jobs with `needs:` dependencies). Without this flag the agent races
   * the orchestrator and self-shuts down before the dispatch arrives.
   * If the dispatch never arrives (orchestrator crash, etc.) the agent's
   * KICI_SCALER_PENDING_DISPATCH_TIMEOUT (default 60s) acts as a safety net.
   */
  pendingDispatch: z.boolean().optional(),
});

// --- Agent -> Orchestrator messages ---

/** Agent registration with capabilities and capacity. */
export const agentRegisterSchema = z.object({
  type: z.literal('agent.register'),
  messageId: z.string(),
  agentId: z.string(),
  labels: z.array(z.string()),
  /** Agent platform (os.platform(), e.g. 'linux', 'darwin', 'win32') */
  platform: z.string().optional(),
  /** Agent architecture (os.arch(), e.g. 'x64', 'arm64') */
  arch: z.string().optional(),
  /** Agent version (e.g. "0.0.1"). Optional for backward compatibility with older agents. */
  version: z.string().optional(),
  /** Maximum concurrent jobs this agent can handle. Defaults to 1 if not specified. */
  maxConcurrency: z.number().int().positive().optional(),
  /** Jobs still running on this agent (sent on reconnection to enable job recovery). */
  inFlightJobs: z
    .array(
      z.object({
        jobId: z.string(),
        runId: z.string(),
      }),
    )
    .optional(),
  // --- Static OS metadata (populated at registration time) ---
  /** Machine hostname (os.hostname()) */
  hostname: z.string().optional(),
  /** OS kernel release (os.release()) */
  osRelease: z.string().optional(),
  /** OS version string (os.version()) */
  osVersion: z.string().optional(),
  /** Total system memory in MiB */
  totalMemoryMb: z.number().optional(),
  /** Number of logical CPUs */
  cpuCount: z.number().optional(),
  /** Node.js version (process.versions.node) */
  nodeVersion: z.string().optional(),
  /** Username of the OS user running the agent process */
  runningAsUser: z.string().optional(),
  /** UID of the OS user running the agent process */
  runningAsUid: z.number().optional(),
});

/** Periodic agent status update. */
export const agentStatusSchema = z.object({
  type: z.literal('agent.status'),
  messageId: z.string(),
  agentId: z.string(),
  activeJobs: z.number(),
  // --- Dynamic OS metadata (updated on each status report) ---
  /** Used memory in MiB (os.totalmem() - os.freemem()) */
  memoryUsedMb: z.number().optional(),
  /** Available memory in MiB (os.freemem()) */
  memoryAvailableMb: z.number().optional(),
  /** System uptime in seconds (os.uptime()) */
  uptimeSeconds: z.number().optional(),
});

/** Job execution state transition report. */
export const jobStatusSchema = z.object({
  type: z.literal('job.status'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  state: ExecutionJobStatus,
  timestamp: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** Job names dropped by determinism drift (agent re-eval produced fewer jobs than expected). */
  droppedJobs: z.array(z.string()).optional(),
  /** Encrypted secret outputs from agent (present on job success when secret outputs exist). */
  secretOutputs: z
    .record(
      z.string(),
      z.object({
        /** Base64-encoded agent ephemeral X25519 public key (DER SPKI). */
        agentPublicKey: z.string(),
        /** Base64-encoded encrypted value: IV (12B) || AuthTag (16B) || Ciphertext. */
        encrypted: z.string(),
      }),
    )
    .optional(),
});

/** Reasons an agent can refuse a job.dispatch. */
export const JobRejectReason = z.enum(['busy', 'draining']);
export type JobRejectReason = z.infer<typeof JobRejectReason>;

/**
 * Explicit dispatch rejection (agent -> orchestrator).
 *
 * Sent when the agent cannot accept a job.dispatch (already running a job,
 * or draining). The orchestrator undoes its dispatch accounting and requeues
 * the job for another agent. Protocol invariant: every job.dispatch is
 * answered — accepted with `job.ack` (a `job.status` with state `running`
 * also resolves the deadline), or refused with this message. An unanswered
 * dispatch is treated as lost once the ack deadline expires (requeue +
 * disconnect the agent) and is also covered by disconnect-time triage.
 */
export const jobRejectSchema = z.object({
  type: z.literal('job.reject'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  reason: JobRejectReason,
  timestamp: z.number(),
});

/**
 * Positive dispatch acknowledgment (agent -> orchestrator).
 *
 * Sent immediately when the agent receives a job.dispatch and accepts it
 * (after the drain/busy checks, before execution begins). The orchestrator
 * arms a deadline when it sends a dispatch; `job.ack`, `job.reject`, or a
 * `job.status` with state `running` resolves it. A dispatch with no answer
 * inside the deadline is treated as lost: the orchestrator requeues the job
 * and disconnects the unresponsive agent.
 */
export const jobAckSchema = z.object({
  type: z.literal('job.ack'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  timestamp: z.number(),
});

/**
 * Streaming log chunk from step execution (agent -> orchestrator).
 *
 * FAST-PATHED: A manual validator exists in
 * packages/orchestrator/src/ws/agent-handler.ts (isValidLogChunk).
 * If you change this schema, update the manual validator in the same commit.
 * See CLAUDE.md rule: "Zod fast-path sync invariant".
 */
export const agentLogChunkSchema = z.object({
  type: z.literal('log.chunk'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number(),
  lines: z.array(z.string()),
  timestamp: z.number(),
});

/** Step-level execution state report (agent -> orchestrator). */
export const agentStepStatusSchema = z.object({
  type: z.literal('step.status'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  stepName: z.string(),
  state: ExecutionStepStatus,
  timestamp: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** Distinguishes regular steps from hook executions. */
  step_type: z
    .enum([
      'step',
      'hook:onCancel',
      'hook:cleanup',
      'hook:onSuccess',
      'hook:onFailure',
      'hook:beforeStep',
      'hook:afterStep',
    ])
    .optional(),
  /** Secret key names accessed by this step via ctx.secrets.get()/expose(). Never contains values. */
  secretsAccessed: z.array(z.string()).optional(),
  /**
   * Total raw bytes streamed by this step's LogStreamer at terminal time.
   * Counts agent-side raw bytes (the same count fed to the transient
   * `kici_agent_log_bytes_total` counter), so it reflects what the customer
   * actually emitted — not gzip archive size or post-processing size.
   * Set on terminal step states only. Reused by the orchestrator to
   * accumulate per-job and per-run totals for the operator-side
   * `kici_org_log_bytes` capacity-planning gauge.
   */
  logBytesStreamed: z.number().int().nonnegative().optional(),
});

/** Periodic job heartbeat from agent to orchestrator (stale run detection). */
const jobHeartbeatSchema = z.object({
  type: z.literal('job.heartbeat'),
  runId: z.string(),
  jobId: z.string(),
  timestamp: z.number(),
});

/** Operational log lines streamed from agent to orchestrator (stateful/external agents). */
const agentLogSchema = z.object({
  type: z.literal('agent.log'),
  messageId: z.string(),
  agentId: z.string(),
  lines: z.array(z.string()),
  timestamp: z.number(),
});

// --- Concurrency protocol (agent <-> orchestrator) ---

/** Agent -> Orchestrator: report that a job belongs to a concurrency group. */
export const jobConcurrencyReportSchema = z.object({
  type: z.literal('job.concurrency.report'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  group: z.string(),
});

/**
 * Orchestrator -> Agent: acknowledge concurrency report with action to take.
 *
 * The orchestrator sends this in two situations:
 * 1. As a direct response to a `job.concurrency.report` message — `requestId`
 *    correlates to the report. Action is `proceed`, `wait`, or `cancel`.
 * 2. As an UNSOLICITED follow-up after the agent received `wait`. When a slot
 *    in the concurrency group is released (by completion, cancellation, or
 *    superseding), the orchestrator picks the FIFO-next queued waiter and
 *    sends `{ action: 'proceed' }` to the agent that's still parked on its
 *    second `waitForConcurrencyAck` call. `runId` / `jobId` are present in
 *    this case so the agent can sanity-check the wake-up matches its job.
 *    The agent's pending-ack slot resolves regardless of `requestId` (single
 *    in-flight ack per workflow-runner process).
 */
export const jobConcurrencyAckSchema = z.object({
  type: z.literal('job.concurrency.ack'),
  requestId: z.string(),
  action: z.enum(['proceed', 'wait', 'cancel']),
  reason: z.string().optional(),
  /** Optional run identifier for unsolicited slot-release wake-ups. */
  runId: z.string().optional(),
  /** Optional job identifier for unsolicited slot-release wake-ups. */
  jobId: z.string().optional(),
});

/** Agent acknowledges receipt of configuration (e.g., MMDS handshake). */
export const configAckSchema = z.object({
  type: z.literal('config.ack'),
  messageId: z.string(),
  agentId: z.string(),
});

// --- Cache upload protocol (agent direct-to-S3 uploads) ---

/** Agent -> Orchestrator: request a pre-signed upload URL for cache storage. */
const cacheUploadRequestSchema = z.object({
  type: z.literal('cache.upload.request'),
  messageId: z.string(),
  jobId: z.string(),
  cacheType: z.enum(['source', 'deps']),
  contentHash: z.string().optional(),
  lockfileHash: z.string().optional(),
  platform: z.string(),
  arch: z.string(),
});

/** Orchestrator -> Agent: return the pre-signed upload URL. */
const cacheUploadResponseSchema = z.object({
  type: z.literal('cache.upload.response'),
  requestId: z.string(),
  uploadUrl: z.string(),
});

/** Agent -> Orchestrator: confirm upload complete (for metadata update). */
const cacheUploadCompleteSchema = z.object({
  type: z.literal('cache.upload.complete'),
  messageId: z.string(),
  jobId: z.string(),
  cacheType: z.enum(['source', 'deps']),
  contentHash: z.string().optional(),
  lockfileHash: z.string().optional(),
  platform: z.string(),
  arch: z.string(),
  /** SHA-256 hash of the dependency tarball for integrity verification. Only present for deps uploads. */
  depsHash: z.string().optional(),
});

// --- User-facing cache protocol (declarative + imperative ctx.cache) ---

/** Agent -> Orchestrator: request a user-cache restore (presigned download). */
export const cacheUserRestoreRequestSchema = z.object({
  type: z.literal('cache.user.restore.request'),
  messageId: z.string(),
  jobId: z.string(),
  /** Exact cache key. */
  key: z.string(),
  /** Ordered prefix fallbacks (newest matching entry wins). */
  restoreKeys: z.array(z.string()).optional(),
});

/** Orchestrator -> Agent: presigned download URL + matched key + tar hash, or a miss. */
export const cacheUserRestoreResponseSchema = z.object({
  type: z.literal('cache.user.restore.response'),
  requestId: z.string(),
  /** True when an entry matched (exact or prefix). */
  hit: z.boolean(),
  /** Full key that matched (exact key or the matched prefix entry's full key). */
  matchedKey: z.string().optional(),
  /** Presigned GET URL for the matched tarball. Present only on hit. */
  downloadUrl: z.string().optional(),
  /** SHA-256 of the tarball bytes for integrity verification on download. */
  tarHash: z.string().optional(),
});

/** Agent -> Orchestrator: request a presigned PUT for a user-cache save (immutable; may decline if key exists). */
export const cacheUserSaveRequestSchema = z.object({
  type: z.literal('cache.user.save.request'),
  messageId: z.string(),
  jobId: z.string(),
  key: z.string(),
});

/** Orchestrator -> Agent: presigned PUT URL, or `skip` when the immutable key already exists. */
export const cacheUserSaveResponseSchema = z.object({
  type: z.literal('cache.user.save.response'),
  requestId: z.string(),
  /** Presigned PUT URL to the temp object. Absent when `skip` is true. */
  uploadUrl: z.string().optional(),
  /** True when the exact key already exists (immutable no-op). */
  skip: z.boolean(),
});

/** Agent -> Orchestrator: confirm a user-cache upload finished; orchestrator commits temp -> final + sets metadata. */
export const cacheUserSaveCompleteSchema = z.object({
  type: z.literal('cache.user.save.complete'),
  messageId: z.string(),
  jobId: z.string(),
  key: z.string(),
  /** SHA-256 of the tarball bytes. */
  tarHash: z.string(),
  /** Tarball size in bytes (drives quota accounting). */
  sizeBytes: z.number().int().nonnegative(),
});

// --- Provenance attestation upload protocol (ctx.attestProvenance) ---

/** Agent -> Orchestrator: request a presigned PUT URL for a provenance bundle. */
export const provenanceUploadRequestSchema = z.object({
  type: z.literal('provenance.upload.request'),
  messageId: z.string(),
  /** Job producing the attestation (ownership-checked; runId resolved server-side). */
  jobId: z.string(),
  /** Primary subject digest (lowercase hex) — the storage-key discriminator. */
  subjectDigest: z.string(),
});

/** Orchestrator -> Agent: presigned PUT URL for the provenance bundle. */
export const provenanceUploadResponseSchema = z.object({
  type: z.literal('provenance.upload.response'),
  requestId: z.string(),
  /** Presigned PUT URL, or '' when storage is unavailable. */
  uploadUrl: z.string(),
});

/** Agent -> Orchestrator: confirm a provenance bundle upload (records an attestations row). */
export const provenanceUploadCompleteSchema = z.object({
  type: z.literal('provenance.upload.complete'),
  messageId: z.string(),
  jobId: z.string(),
  /** Caller-supplied artifact name. */
  subjectName: z.string(),
  /** Primary subject digest (lowercase hex). */
  subjectDigest: z.string(),
  /** Bundle media type. */
  mediaType: z.string(),
});

// --- Event emit protocol (custom event emission from workflow steps) ---

/** Agent -> Orchestrator: emit a custom event from a running workflow step. */
export const eventEmitSchema = z.object({
  type: z.literal('event.emit'),
  /** Job that is emitting the event. */
  jobId: z.string(),
  /** Correlates to the runner's request for response routing. */
  requestId: z.string(),
  /** Custom event name (e.g. 'deploy-complete'). */
  eventName: z.string(),
  /** Event payload (arbitrary JSON-serializable data). */
  payload: z.record(z.string(), z.unknown()),
  /** Optional targeting for cross-repo delivery. */
  target: z
    .object({
      repos: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Orchestrator -> Agent: response confirming event delivery. */
export const eventEmitResponseSchema = z.object({
  type: z.literal('event.emit.response'),
  /** Correlates to the original event.emit requestId. */
  requestId: z.string(),
  /** Delivery ID assigned by the orchestrator (present on success). */
  deliveryId: z.string().optional(),
  /** Error description (present on failure). */
  error: z.string().optional(),
});

// --- Agent metrics push protocol ---

/** Periodic metrics push from agent to orchestrator. */
export const agentMetricsSchema = z.object({
  type: z.literal('agent.metrics'),
  messageId: z.string(),
  agentId: z.string(),
  metrics: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['counter', 'histogram', 'gauge', 'upDownCounter']),
      value: z.number().optional(),
      labels: z.record(z.string(), z.string()).optional(),
      buckets: z
        .array(
          z.object({
            le: z.number(),
            count: z.number(),
          }),
        )
        .optional(),
      count: z.number().optional(),
      sum: z.number().optional(),
    }),
  ),
  timestamp: z.number(),
});

// --- Agent auth protocol messages ---
// Used during WebSocket connection establishment between agent and orchestrator.
// Mirrors the Platform tier's auth.request/auth.success/auth.failure from auth.ts for cross-tier consistency.

/** Auth request sent by agent to orchestrator when connecting via WebSocket. */
export const agentAuthRequestSchema = z.object({
  type: z.literal('auth.request'),
  token: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

/** Auth success response sent by orchestrator to agent after successful authentication. */
export const agentAuthSuccessSchema = z.object({
  type: z.literal('auth.success'),
  connectionId: z.string(),
});

/** Auth failure response sent by orchestrator to agent when authentication fails. */
export const agentAuthFailureSchema = z.object({
  type: z.literal('auth.failure'),
  reason: z.string(),
});

// --- Agent private API (request-response over WS) ---
// Generic envelope for typed API calls. New methods are registered in AgentApiRegistry
// on the orchestrator side — no protocol schema changes needed per method.

/** API request sent by agent to orchestrator (e.g., infrastructure.list). */
export const agentApiRequestSchema = z.object({
  type: z.literal('agent.api.request'),
  /** UUID for correlating the response. */
  requestId: z.string(),
  /** Dot-namespaced method name (e.g., 'infrastructure.list'). */
  method: z.string(),
  /** Method-specific parameters. */
  params: z.record(z.string(), z.unknown()).default({}),
});

/** API response sent by orchestrator to agent. */
export const agentApiResponseSchema = z.object({
  type: z.literal('agent.api.response'),
  /** Matches the original request's requestId. */
  requestId: z.string(),
  /** Method result (present on success). */
  result: z.unknown().optional(),
  /** Error description (present on failure). */
  error: z.string().optional(),
});

// --- Fleet log collection (orchestrator → agent request / agent → orchestrator chunked response) ---

/** Orchestrator asks an agent for its log/diagnostic mini-bundle. */
export const fleetLogsRequestSchema = z.object({
  type: z.literal('fleet.logs.request'),
  /** UUID correlating the chunked response. */
  requestId: z.string(),
  /** Hours of log history to include. */
  logWindowHours: z.number(),
  /** Per-node cap on raw log bytes. */
  maxBytes: z.number(),
});

/** One base64 frame of an agent's mini-bundle ZIP. */
export const fleetBundleChunkSchema = z.object({
  type: z.literal('fleet.bundle.chunk'),
  requestId: z.string(),
  seq: z.number().int().nonnegative(),
  isLast: z.boolean(),
  dataB64: z.string(),
});

/** Agent failed to build/stream its mini-bundle. */
export const fleetBundleErrorSchema = z.object({
  type: z.literal('fleet.bundle.error'),
  requestId: z.string(),
  message: z.string(),
});

// --- Step-level approval round-trip (agent <-> orchestrator) ---

/** Outcome of a step-level approval hold, sent back to the waiting agent. */
export const StepApprovalOutcome = z.enum(['approved', 'rejected', 'expired']);
export type StepApprovalOutcome = z.infer<typeof StepApprovalOutcome>;

/**
 * Agent -> Orchestrator: a step carrying `requireApproval` is about to run and
 * the agent is blocking its step loop until the orchestrator resolves the
 * approval. The orchestrator creates a step-scoped `held_runs` row from the
 * normalized requirement and replies with `step.approval-resolved` once the
 * hold is approved, rejected, or expired. The agent keeps heartbeats flowing
 * during the wait so it is not reaped as stale.
 *
 * NOT fast-pathed — the `log.chunk` / `heartbeat` manual-validator invariant is
 * untouched by this message.
 */
export const stepApprovalRequestSchema = z.object({
  type: z.literal('step.approval-request'),
  messageId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  stepName: z.string(),
  /** AND-list of approver clauses (empty = any approval-capable member). */
  clauses: z.array(approverClauseSchema),
  /** Human label for the gate (from the SDK `requireApproval` reason). */
  reason: z.string(),
  /**
   * Per-gate timeout override (seconds) from the SDK `requireApproval.timeout`.
   * Absent ⇒ the orchestrator uses the org-default `approval_expiry_seconds`.
   * The orchestrator owns the authoritative `expiresAt` computation.
   */
  timeoutSeconds: z.number().int().positive().optional(),
});
export type StepApprovalRequest = z.infer<typeof stepApprovalRequestSchema>;

/**
 * Orchestrator -> Agent: resolution of a step-level approval hold. `requestId`
 * correlates to the originating `step.approval-request.messageId`. On
 * `approved` the agent runs the step with its live workspace intact; on
 * `rejected`/`expired` it fails the job with a clear reason.
 */
export const stepApprovalResolvedSchema = z.object({
  type: z.literal('step.approval-resolved'),
  /** Correlates to the originating step.approval-request messageId. */
  requestId: z.string(),
  runId: z.string(),
  jobId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  outcome: StepApprovalOutcome,
  /** Optional human reason (e.g. the reject reason). */
  reason: z.string().optional(),
});
export type StepApprovalResolved = z.infer<typeof stepApprovalResolvedSchema>;

// --- Direction-specific discriminated unions ---

/** All messages that flow from Orchestrator to Agent. */
export const orchestratorToAgentMessageSchema = z.discriminatedUnion('type', [
  jobDispatchSchema,
  jobCancelSchema,
  registerAckSchema,
  jobConcurrencyAckSchema,
  cacheUploadResponseSchema,
  cacheUserRestoreResponseSchema,
  cacheUserSaveResponseSchema,
  provenanceUploadResponseSchema,
  eventEmitResponseSchema,
  agentApiResponseSchema,
  agentAuthSuccessSchema,
  agentAuthFailureSchema,
  fleetLogsRequestSchema,
  stepApprovalResolvedSchema,
]);

/** All messages that flow from Agent to Orchestrator. */
export const agentToOrchestratorMessageSchema = z.discriminatedUnion('type', [
  agentRegisterSchema,
  agentStatusSchema,
  jobStatusSchema,
  jobRejectSchema,
  jobAckSchema,
  agentLogChunkSchema,
  agentStepStatusSchema,
  jobHeartbeatSchema,
  agentLogSchema,
  jobConcurrencyReportSchema,
  configAckSchema,
  cacheUploadRequestSchema,
  cacheUploadCompleteSchema,
  cacheUserRestoreRequestSchema,
  cacheUserSaveRequestSchema,
  cacheUserSaveCompleteSchema,
  provenanceUploadRequestSchema,
  provenanceUploadCompleteSchema,
  eventEmitSchema,
  agentApiRequestSchema,
  agentMetricsSchema,
  agentAuthRequestSchema,
  fleetBundleChunkSchema,
  fleetBundleErrorSchema,
  stepApprovalRequestSchema,
]);

// --- Inferred types ---

export type JobDispatch = z.infer<typeof jobDispatchSchema>;
export type JobCancel = z.infer<typeof jobCancelSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobReject = z.infer<typeof jobRejectSchema>;
export type JobAck = z.infer<typeof jobAckSchema>;
export type AgentLogChunk = z.infer<typeof agentLogChunkSchema>;
export type AgentStepStatus = z.infer<typeof agentStepStatusSchema>;
export type AgentMetrics = z.infer<typeof agentMetricsSchema>;
export type CacheUserRestoreRequest = z.infer<typeof cacheUserRestoreRequestSchema>;
export type CacheUserRestoreResponse = z.infer<typeof cacheUserRestoreResponseSchema>;
export type CacheUserSaveRequest = z.infer<typeof cacheUserSaveRequestSchema>;
export type CacheUserSaveResponse = z.infer<typeof cacheUserSaveResponseSchema>;
export type CacheUserSaveComplete = z.infer<typeof cacheUserSaveCompleteSchema>;
export type ProvenanceUploadRequest = z.infer<typeof provenanceUploadRequestSchema>;
export type ProvenanceUploadResponse = z.infer<typeof provenanceUploadResponseSchema>;
export type ProvenanceUploadComplete = z.infer<typeof provenanceUploadCompleteSchema>;
export type FleetLogsRequest = z.infer<typeof fleetLogsRequestSchema>;
export type FleetBundleChunk = z.infer<typeof fleetBundleChunkSchema>;
export type FleetBundleError = z.infer<typeof fleetBundleErrorSchema>;
export type OrchestratorToAgentMessage = z.infer<typeof orchestratorToAgentMessageSchema>;
export type AgentToOrchestratorMessage = z.infer<typeof agentToOrchestratorMessageSchema>;
