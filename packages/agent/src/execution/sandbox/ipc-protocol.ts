import type { CheckMode, CheckStepOutcome } from '@kici-dev/engine';
import type { SandboxStepResult } from './types.js';

/**
 * Structured clone auth. Wire-compatible with `gitAuthSchema` on the
 * orchestrator-agent protocol and `GitAuth` in `checkout/git-clone.ts`.
 * Declared independently here so the sandbox IPC module has no runtime
 * dependency on the engine protocol package.
 */
export interface GitAuthDispatch {
  kind: 'basic' | 'ssh';
  user?: string;
  secret: string;
  sshHostKeyPolicy?: 'accept-new' | 'pinned';
  sshKnownHostsPem?: string;
}

// --- Runner -> Agent messages (from workflow runner to agent process) ---

/** Workflow runner is initialized and ready to receive a job. */
interface ReadyMessage {
  type: 'ready';
}

/** A step has started executing. */
interface StepStartMessage {
  type: 'step.start';
  stepIndex: number;
  stepName: string;
  /** Distinguishes regular steps from hook executions (e.g., 'hook:onCancel', 'hook:cleanup'). Defaults to 'step'. */
  step_type?: string;
}

/** A step has completed (success, failure, or a check-mode skip). */
interface StepCompleteMessage {
  type: 'step.complete';
  stepIndex: number;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  error?: {
    message: string;
    exitCode?: number;
    signal?: string;
  };
  /** Step return value (outputs). Present on success when step returns non-void. */
  outputs?: Record<string, unknown>;
  /** Distinguishes regular steps from hook executions (e.g., 'hook:onCancel', 'hook:cleanup'). Defaults to 'step'. */
  step_type?: string;
  /** Secret key names accessed by this step via ctx.secrets.get() or ctx.secrets.expose(). Never contains values. */
  secretsAccessed?: string[];
  /**
   * Structured per-step metadata forwarded to the orchestrator's `step.status`
   * `data` field (and persisted for the dashboard timeline). The cache
   * pseudo-steps carry `{ cacheOutcome, key, matchedKey?, bytes? }` here.
   */
  data?: Record<string, unknown>;
  /**
   * Idempotent per-step outcome (`CheckStepOutcome`). Present only when the run
   * carried a check mode and the step has a `check` facet (or was a plain step
   * skipped under check mode). Orthogonal to `status`.
   */
  checkOutcome?: CheckStepOutcome;
  /** Human-readable drift summary (`summarize(drift)`). Present when drift was detected. */
  driftSummary?: string;
  /** Structured drift value returned by `check()`. Present when drift was detected. */
  drift?: unknown;
}

/** A single log line from step execution. */
interface LogLineMessage {
  type: 'log.line';
  stepIndex: number;
  line: string;
}

/**
 * Discriminator for {@link StepSecretMountMessage} -- distinguishes a bare
 * `ctx.secrets.mountFile` call from a `ctx.secrets.exposeFile` call (the
 * latter additionally sets an env var on the step's process).
 */
export type StepSecretMountKind = 'mountFile' | 'exposeFile';

/**
 * Audit event emitted once per `ctx.secrets.mountFile` / `exposeFile` call.
 * Carries only key names + the resulting path / env var -- never the file
 * content. Persisted by the orchestrator alongside `secretsAccessed` so the
 * dashboard can render the materialised-file audit trail.
 */
interface StepSecretMountMessage {
  type: 'step.secret_mount';
  stepIndex: number;
  /** Source secret keys (in concatenation order). */
  sources: string[];
  /** Absolute path the file was materialised to inside the step sandbox. */
  target: string;
  /** Env var set when `kind === 'exposeFile'`; otherwise omitted. */
  envVar?: string;
  /** Discriminator between `mountFile` and `exposeFile`. */
  kind: StepSecretMountKind;
}

/** The entire job has completed. */
interface JobCompleteMessage {
  type: 'job.complete';
  status: 'success' | 'failed';
  stepResults: SandboxStepResult[];
  /** Error message when the job failed before step execution (e.g. clone, deps, compile). */
  error?: string;
  /** Aggregated step outputs by step name. Present on success when steps produce outputs. */
  outputs?: Record<string, Record<string, unknown>>;
  /** Secret output values collected during step execution (plaintext -- encryption happens in the agent before WS send). */
  secretOutputs?: Record<string, string>;
  /** Names of sibling jobs dropped by DynamicJobFn re-evaluation drift. */
  droppedJobs?: string[];
}

/** Request to emit a custom event from a workflow step (runner -> agent). */
export interface EventEmitRequest {
  type: 'event.emit';
  /** Unique ID for correlating the response back to the caller. */
  requestId: string;
  /** Custom event name (e.g. 'deploy-complete'). */
  eventName: string;
  /** Event payload (arbitrary JSON-serializable data). */
  payload: Record<string, unknown>;
  /** Optional targeting for cross-repo delivery. */
  target?: { repos?: string[] };
}

/** Report evaluated concurrency group key (runner -> agent -> orchestrator). */
export interface ConcurrencyReportMessage {
  type: 'concurrency.report';
  /** Evaluated concurrency group key (e.g. 'deploy-main'). */
  group: string;
}

/**
 * Discriminated union of all messages sent from the workflow runner to the agent.
 *
 * The workflow runner sends these via:
 * - Node.js IPC channel (`process.send()`) for bare-metal/Firecracker backends
 * - stdout JSON-lines for container backend (`docker exec`)
 */
/** API request from runner to agent (relayed to orchestrator via WS). */
export interface AgentApiRequestIpc {
  type: 'agent.api.request';
  /** UUID for correlating the response. */
  requestId: string;
  /** Dot-namespaced method name (e.g., 'infrastructure.list'). */
  method: string;
  /** Method-specific parameters. */
  params: Record<string, unknown>;
}

/**
 * Operation requested by a user-facing cache IPC message.
 *
 * - `restore` — look up a cache entry (exact key + prefix fallbacks).
 * - `beginSave` — request a presigned PUT (declined when the immutable key exists).
 * - `completeSave` — confirm the upload so the orchestrator commits temp -> final.
 */
export type CacheRequestOp = 'restore' | 'beginSave' | 'completeSave';

/**
 * Request a user-facing cache operation (runner -> agent). The sandbox runner
 * can't open a WS, so it sends this IPC; the agent relays it to the
 * orchestrator over the WS as a `cache.user.*` message and pipes the response
 * back as a {@link CacheResponseIpc}. Mirrors the {@link AgentApiRequestIpc}
 * relay pattern.
 */
export interface CacheRequestIpc {
  type: 'cache.request';
  /** UUID for correlating the response. */
  requestId: string;
  /** Which cache operation to perform. */
  op: CacheRequestOp;
  /** Exact cache key (all ops). */
  key: string;
  /** Ordered prefix fallbacks (newest matching entry wins). `restore` only. */
  restoreKeys?: string[];
  /** SHA-256 of the uploaded tarball bytes. `completeSave` only. */
  tarHash?: string;
  /** Tarball size in bytes (drives quota accounting). `completeSave` only. */
  sizeBytes?: number;
}

/**
 * Request a step-level approval hold (runner -> agent). The sandbox runner
 * blocks the step loop before a `requireApproval` step; the agent relays this
 * as a `step.approval-request` WS message and pipes the orchestrator's
 * resolution back as a {@link StepApprovalResolvedIpc}. Mirrors the
 * {@link CacheRequestIpc} relay pattern.
 */
export interface StepApprovalRequestIpc {
  type: 'approval.request';
  /** UUID for correlating the response. */
  requestId: string;
  /** Step index within the job. */
  stepIndex: number;
  /** Step name (for the hold reason / logs). */
  stepName: string;
  /** AND-list of approver clauses (empty = any approval-capable member). */
  clauses: Array<{ team: string } | { user: string }>;
  /** Human label for the gate. */
  reason: string;
  /** Per-gate timeout override (seconds) from the SDK `approval.timeout`. */
  timeoutSeconds?: number;
  /** Computed drift payload, present only for `when: 'drift'` gates. */
  payload?: { summaryMarkdown: string; drift: unknown };
}

/** Which provenance upload operation to relay. */
export type ProvenanceRequestOp = 'requestUploadUrl' | 'complete';

/**
 * Request a provenance bundle upload operation (runner -> agent). The agent
 * relays it over the WS as a `provenance.upload.request` / `.complete` and pipes
 * the response back as a {@link ProvenanceResponseIpc}. Mirrors the
 * {@link CacheRequestIpc} relay pattern.
 */
export interface ProvenanceRequestIpc {
  type: 'provenance.request';
  /** UUID for correlating the response. */
  requestId: string;
  /** Which provenance operation to perform. */
  op: ProvenanceRequestOp;
  /** Primary subject digest (lowercase hex) — the storage-key discriminator. */
  subjectDigest: string;
  /** Caller-supplied artifact name. `complete` only. */
  subjectName?: string;
  /** Bundle media type. `complete` only. */
  mediaType?: string;
}

export type RunnerToAgentMessage =
  | ReadyMessage
  | StepStartMessage
  | StepCompleteMessage
  | LogLineMessage
  | StepSecretMountMessage
  | JobCompleteMessage
  | EventEmitRequest
  | ConcurrencyReportMessage
  | AgentApiRequestIpc
  | CacheRequestIpc
  | ProvenanceRequestIpc
  | StepApprovalRequestIpc;

// --- Agent -> Runner messages (from agent process to workflow runner) ---

/** Instruct the workflow runner to execute a job. */
interface ExecuteMessage {
  type: 'execute';
  request: JobExecutionRequest;
}

/** Instruct the workflow runner to abort the current job. */
interface AbortMessage {
  type: 'abort';
  /** When true, force-cancel immediately (SIGKILL, skip hooks). When false, graceful cancel (run hooks). */
  force?: boolean;
}

/** Response confirming event delivery (agent -> runner). */
export interface EventEmitResponse {
  type: 'event.emit.response';
  /** Correlates to the original EventEmitRequest.requestId. */
  requestId: string;
  /** Delivery ID assigned by the orchestrator (present on success). */
  deliveryId?: string;
  /** Error description (present on failure). */
  error?: string;
}

/** Concurrency ack from orchestrator relayed to runner (agent -> runner). */
export interface ConcurrencyAckMessage {
  type: 'concurrency.ack';
  /** Action to take: proceed with execution, wait (release slot), or cancel the job. */
  action: 'proceed' | 'wait' | 'cancel';
  /** Optional reason for wait or cancel. */
  reason?: string;
}

/**
 * Discriminated union of all messages sent from the agent to the workflow runner.
 *
 * The agent sends these via:
 * - Node.js IPC channel (`child.send()`) for bare-metal/Firecracker backends
 * - stdin JSON-line for container backend (`docker exec`)
 */
/** API response from agent to runner (relayed from orchestrator via WS). */
export interface AgentApiResponseIpc {
  type: 'agent.api.response';
  /** Matches the original request's requestId. */
  requestId: string;
  /** Method result (present on success). */
  result?: unknown;
  /** Error description (present on failure). */
  error?: string;
}

/**
 * Response to a {@link CacheRequestIpc} (agent -> runner). Relayed from the
 * orchestrator's `cache.user.*.response` WS message. Carries the union of the
 * restore-response (`hit` / `matchedKey` / `downloadUrl` / `tarHash`) and
 * save-response (`skip` / `uploadUrl`) fields; `completeSave` resolves with an
 * empty (no-field) response. `error` is set when the relay or orchestrator
 * failed.
 */
export interface CacheResponseIpc {
  type: 'cache.response';
  /** Matches the original request's requestId. */
  requestId: string;
  /** Restore: true when an entry matched (exact or prefix). */
  hit?: boolean;
  /** Restore: full key that matched (exact key or matched prefix entry's key). */
  matchedKey?: string;
  /** Restore: presigned GET URL for the matched tarball (present only on hit). */
  downloadUrl?: string;
  /** Restore: SHA-256 of the tarball bytes for download integrity verification. */
  tarHash?: string;
  /** Save: true when the immutable key already exists (upload skipped). */
  skip?: boolean;
  /** Save: presigned PUT URL to the temp object (absent when `skip`). */
  uploadUrl?: string;
  /** Error description (present when the relay or orchestrator failed). */
  error?: string;
}

/**
 * Resolution of a step-level approval hold (agent -> runner). Relayed from the
 * orchestrator's `step.approval-resolved` WS message. On `approved` the runner
 * runs the step; on `rejected`/`expired` it fails the job. `error` is set when
 * the relay itself failed (treated as a fail-closed reject by the runner).
 */
export interface StepApprovalResolvedIpc {
  type: 'approval.resolved';
  /** Matches the original request's requestId. */
  requestId: string;
  /** Outcome of the hold. */
  outcome?: 'approved' | 'rejected' | 'expired';
  /** Optional human reason (e.g. the reject reason). */
  reason?: string;
  /** Error description (present when the relay or orchestrator failed). */
  error?: string;
}

/**
 * Response to a {@link ProvenanceRequestIpc} (agent -> runner). `requestUploadUrl`
 * resolves with `uploadUrl`; `complete` resolves with an empty (no-field)
 * response. `error` is set when the relay or orchestrator failed.
 */
export interface ProvenanceResponseIpc {
  type: 'provenance.response';
  /** Matches the original request's requestId. */
  requestId: string;
  /** Presigned PUT URL for the bundle. `requestUploadUrl` only. */
  uploadUrl?: string;
  /** Error description (present when the relay or orchestrator failed). */
  error?: string;
}

export type AgentToRunnerMessage =
  | ExecuteMessage
  | AbortMessage
  | EventEmitResponse
  | ConcurrencyAckMessage
  | AgentApiResponseIpc
  | CacheResponseIpc
  | ProvenanceResponseIpc
  | StepApprovalResolvedIpc;

// --- Job execution request ---

/**
 * All data the workflow runner needs to execute a job inside the sandbox.
 *
 * Sent from the agent to the runner as part of the `execute` message.
 * The runner uses this to clone, install deps, compile, and execute steps.
 */
export interface JobExecutionRequest {
  /**
   * Run UUID. Threaded into the step context so the OIDC token relay can name
   * the job/run a request is bound to. Correlation only — the orchestrator
   * re-derives ownership and the runId from its own dispatch state.
   */
  runId: string;
  /**
   * Job UUID. Sent with `ctx.kici.oidc.token()` requests so the orchestrator
   * can verify the agent owns this job before relaying a mint request.
   */
  jobId: string;
  /** Working directory inside the sandbox (e.g. /workspace). */
  workDir: string;
  /** Repository URL for git clone. */
  repoUrl: string;
  /** Git ref to checkout (branch or tag). */
  ref: string;
  /** Git commit SHA. */
  sha: string;
  /**
   * Short-lived clone token (optional, for private repos).
   *
   * Deprecated in favour of `sourceAuth` / `workflowAuth` — retained as a
   * back-compat field so same-provider GitHub App flows keep working while
   * universal-git / cross-provider dispatches migrate to structured auth.
   */
  token?: string;
  /**
   * Structured auth for the source repo clone (Phase 4). When set, the
   * workflow runner uses this instead of `token`.
   */
  sourceAuth?: GitAuthDispatch;
  /**
   * Structured auth for the workflow repo clone (global workflows only,
   * Phase 4). Falls back to `sourceAuth` → `token` when absent.
   */
  workflowAuth?: GitAuthDispatch;

  /** URL to a pre-packed `.kici/` source tarball (skip clone if present). */
  sourceTarUrl?: string;
  /** SHA-256 hash of the source tarball bytes for integrity verification. */
  sourceTarHash?: string;

  /** URL to pre-built dependency tarball (skip install if present). */
  depsUrl?: string;
  /** SHA-256 hash of the dependency tarball for integrity verification. */
  depsHash?: string;

  /** Workflow name to execute. */
  workflowName: string;
  /**
   * Job name used to locate the job in the compiled workflow and to populate
   * `ctx.job.name`. For a matrix child this is the BASE job name (the job is
   * defined once in source); the combination is exposed only via `ctx.matrix`.
   */
  jobName: string;
  /** Runs-on label for the job. */
  runsOn: string;
  /**
   * Matrix combination values for this child (e.g. `{ variant: 'a' }`), exposed
   * to steps as `ctx.matrix`. Absent for non-matrix jobs.
   */
  matrixValues?: Record<string, unknown>;
  /**
   * For a `runsOnAll` host-fanout child: the hostname this child runs on,
   * exposed to steps as `ctx.host`. Absent for non-host jobs.
   */
  host?: string;
  /**
   * For a `runsOnAll` host-fanout child: the resolved agent facts, exposed to
   * steps as `ctx.agent`. Absent for non-host jobs.
   */
  agent?: {
    host: string;
    labels: string[];
    platform?: string;
    arch?: string;
  };

  /** Secrets to merge into step environment (highest precedence). */
  secrets?: Record<string, string>;
  /** Namespaced secrets by context name for ctx.secrets['context-name'].KEY access. */
  namespacedSecrets?: Record<string, Record<string, string>>;
  /** Secret metadata from resolveForJobWithMeta (backend + scope per key). */
  secretMeta?: Record<string, { value: string; backend: string; scope: string }>;

  /** Source file path for workflow compilation (relative to repo root). */
  sourceFile?: string;
  /** Content hash of the source file for cache key. */
  contentHash?: string;
  /** Resolved hash files for content-addressed caching. */
  resolvedHashFiles?: string[];

  /** Max log size per step in bytes (runner enforces truncation). */
  maxLogSizeBytes?: number;
  /** Default step timeout in milliseconds. */
  defaultStepTimeoutMs?: number;
  /** Total job wall-clock timeout in milliseconds (init + all steps + hooks). When set, the runner aborts the job on breach and reports TimeoutReason.job_timeout. From the lock job's `timeout`. */
  jobTimeoutMs?: number;

  /** Container configuration passthrough (for container-aware steps). */
  container?: Record<string, unknown>;
  /** Normalized event envelope (type/action/targetBranch/payload…) for rule evaluation and step context. */
  event?: Record<string, unknown>;
  /** Git provider that originated the triggering event (e.g. 'github', 'forgejo'). */
  provider?: string;
  /** Whether to checkout the repo (default: true). */
  checkout?: boolean;
  /** Whether this job is part of a test run triggered by `kici test`. */
  isTestRun?: boolean;
  /**
   * Run mode for idempotent steps (`apply` | `check` | `check-fail-on-drift`).
   * Threaded from the dispatch event. In check / check-fail-on-drift mode the
   * runner previews drift and never invokes a checked step's apply (`run`).
   * Defaults to `apply` when unset.
   */
  checkMode?: CheckMode;
  /** When true, skip git clone -- use overlay tarball as complete workspace. */
  fullRepo?: boolean;

  /** URL to download the encrypted overlay tarball (test runs with uncommitted changes). */
  tarballUrl?: string;
  /** Base64-encoded CLI ephemeral public key for overlay decryption (DER/SPKI). */
  cliPublicKey?: string;
  /** Base64-encoded orchestrator ephemeral private key for overlay decryption (DER/PKCS8). */
  orchestratorPrivateKey?: string;

  /** Base64-encoded X25519 public key for the run (for encrypting secret outputs). */
  runPublicKey?: string;

  /** Deployment environment name (resolved by orchestrator). */
  environment?: string;
  /** Environment variables from orchestrator (org-level + source overrides, layers 4-5). */
  environmentVars?: Record<string, string>;
  /** Job env from lock file env field (layer 6, evaluated by orchestrator). */
  jobEnv?: Record<string, string>;

  // --- Global workflow fields ---

  /** Whether this is a global workflow (dual-clone: workflow repo + source repo). */
  isGlobalWorkflow?: boolean;
  /** Clone URL for the workflow (registering) repo. Only set when isGlobalWorkflow is true. */
  workflowRepoUrl?: string;
  /** Git ref for the workflow repo. */
  workflowRef?: string;
  /** Git commit SHA for the workflow repo. */
  workflowSha?: string;
  /** Repository identifier for the workflow repo (e.g., "org/workflow-repo"). */
  workflowRepoIdentifier?: string;

  /** Whether the workflow has a concurrency group function to evaluate. */
  hasConcurrencyGroup?: boolean;
  /** Concurrency group evaluation timeout in milliseconds (default: 30000). */
  concurrencyEvaluationTimeoutMs?: number;
  /** Git branch for concurrency group context. */
  branch?: string;

  /** Plain outputs from upstream jobs (keyed by job name, then by step name). For ctx.jobOutputs(). */
  upstreamJobOutputs?: Record<string, Record<string, unknown>>;

  /** Terminal status of each upstream job (keyed by job name; per-child for fan-out). For ctx.needs.<job>.status. */
  upstreamJobStatuses?: Record<string, import('@kici-dev/engine').ExecutionJobStatus>;

  /** This job's declared upstream needs (normalized lock edges) used to shape ctx.needs for steps. */
  jobNeeds?: readonly unknown[];

  /** Resolved private npm registries for `npm install` auth (token bytes already filled). */
  npmRegistries?: ReadonlyArray<{
    url: string;
    scope?: string;
    alwaysAuth: boolean;
    token: string;
  }>;
  /** Bare-name secrets to project as install-subprocess env vars. */
  installEnvSecrets?: Record<string, string>;
  /** Short job-scoped nonce — used as suffix on synthesized npm-token env vars. */
  jobIdShort?: string;

  /**
   * Source of a dynamically generated job (from DynamicJobFn).
   * When set, the workflow runner re-evaluates the DynamicJobFn to extract
   * step functions instead of looking up the job in the static jobs array.
   */
  dynamicSource?: {
    /** Index of the DynamicJobFn in the workflow's jobs array. */
    index: number;
    /** Original event payload (passed to DynamicJobFn for re-evaluation). */
    event: Record<string, unknown>;
    /** Expected job names from the original eval (for determinism validation). */
    expectedJobNames?: string[];
    /**
     * Frozen upstream-output snapshot for a result-aware generator. When present
     * the re-eval rebuilds `ctx.needs` from this snapshot (never a live read),
     * so the generator sees the same upstream data as the original eval.
     */
    upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot;
    /** Declared upstream needs (normalized lock edges) used to shape ctx.needs. */
    declaredNeeds?: readonly unknown[];
  };
}
