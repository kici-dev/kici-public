import type { JobDispatch, LogStream } from '@kici-dev/engine';
import type {
  EventEmitRequest,
  EventEmitResponse,
  ConcurrencyReportMessage,
  ConcurrencyAckMessage,
  CacheRequestIpc,
  GitGrantRequestIpc,
  GitGrantResponseIpc,
  CacheResponseIpc,
  ProvenanceRequestIpc,
  ProvenanceResponseIpc,
  ArtifactRequestIpc,
  ArtifactResponseIpc,
  StepApprovalRequestIpc,
  StepApprovalResolvedIpc,
} from './ipc-protocol.js';

// --- Sandbox lifecycle interface ---

/**
 * Common interface for all execution sandbox backends.
 *
 * All three backends (container, bare-metal, Firecracker) implement this
 * interface to provide isolated code execution with a consistent lifecycle:
 *   setup -> executeJob -> teardown (with abort available at any time)
 *
 * The sandbox isolates customer code from agent-internal credentials and
 * resources. The agent process never loads or executes customer code directly.
 */
export interface ExecutionSandbox {
  /**
   * Prepare the sandbox environment.
   *
   * - Container: create + start disposable container
   * - Bare-metal: validate bwrap availability
   * - Firecracker: no-op (VM already running, managed by scaler)
   */
  setup(options: SandboxSetupOptions): Promise<void>;

  /**
   * Execute the full job lifecycle inside the sandbox.
   *
   * Handles: clone, dependency install, compile, step execution.
   * Returns step results via callbacks as they complete.
   */
  executeJob(options: JobExecutionOptions): Promise<JobExecutionResult>;

  /**
   * Abort a running job.
   *
   * Sends SIGTERM to the sandbox process, waits a grace period (~10s),
   * then sends SIGKILL if the process has not exited.
   */
  abort(): Promise<void>;

  /**
   * Tear down the sandbox environment.
   *
   * - Container: docker rm -f
   * - Bare-metal: process cleanup
   * - Firecracker: no-op (VM lifecycle managed by scaler)
   */
  teardown(): Promise<void>;

  /**
   * SIGTERM → grace → SIGKILL the finished job's process group, reaping any
   * daemon a step backgrounded. Returns the number of reap attempts that
   * signalled a live group. Only the bare-metal backend reaps a process group;
   * others (which reap their whole tree on teardown) omit this.
   */
  reap?(): Promise<number>;

  /**
   * Whether the runner signalled that its completion hooks ran before it exited.
   * `false` means the runner was hard-killed before running declared cleanup —
   * the between-jobs phase's cue to re-run it out-of-band. Absent ⇒ treated as
   * `true` (no re-run) for backends that reap their whole tree.
   */
  readonly completionHooksRan?: boolean;

  /** Whether the job declares an `onFailure` / `cleanup` hook (bare-metal). */
  readonly declaresCleanup?: boolean;

  /**
   * Re-run the finished job's declared cleanup / onFailure hooks out-of-band,
   * against the preserved workdir, in a fresh bounded child. Resolves on success
   * and rejects on failure so the caller can time it out. Bare-metal only.
   */
  runCleanupOnly?(workDir: string, signal: AbortSignal): Promise<void>;
}

// --- Setup options ---

/** Options for preparing the sandbox environment. */
export interface SandboxSetupOptions {
  /** Container image (container backend only, e.g. 'node:20-alpine'). */
  image?: string;
  /** Working directory for the job on the host. */
  workDir: string;
  /** Sanitized environment variables (user env + secrets, NO agent credentials). */
  env: Record<string, string>;
  /**
   * Extra read-only host paths to expose in the sandbox beyond the workspace +
   * runner — the `file://` clone-source dir(s) so the in-sandbox `git clone`
   * can read a local source. Derived from the dispatch `repoUrl` by the
   * job-runner (empty for https/ssh remotes). The container backend binds each
   * as `<dir>:<dir>:ro`; the bare-metal backend derives its own equivalent
   * inside `executeJob`, so it ignores this field.
   */
  extraReadOnlyBinds?: string[];
  /**
   * Populate the sandbox workspace from `workDir` instead of letting the runner
   * clone inside it.
   *
   * Set when the AGENT already cloned on the host. The container backend packs
   * `workDir` and copies it into the container's `/workspace` volume; the
   * bare-metal backend already runs against `workDir` directly and ignores it.
   *
   * Cloning on the host is what lets a container image ship without git — and
   * it puts clone-time credentials on the host, where the credential helper
   * already works, instead of needing a route into a hardened container.
   */
  workspaceFromHost?: boolean;
}

// --- Job execution options ---

/** Options for executing a job inside the sandbox. */
export interface JobExecutionOptions {
  /** Dispatch data from the orchestrator (repo URL, ref, sha, token, etc.). */
  dispatch: JobDispatch;
  /** Callback for real-time step status updates (start, success, failed). */
  onStepStatus: (
    stepIndex: number,
    name: string,
    state: string,
    data?: Record<string, unknown>,
  ) => void;
  /**
   * Callback for real-time log line forwarding. `stream` names the subprocess
   * stream the line came from; absent means stdout.
   */
  onLogLine: (stepIndex: number, line: string, stream?: LogStream) => void;
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /**
   * Callback for relaying event.emit requests from the sandbox to the orchestrator.
   * The sandbox runner sends event.emit IPC messages; the agent wraps them in WS
   * protocol and forwards to the orchestrator. Returns the orchestrator's response.
   */
  onEventEmit: (request: EventEmitRequest) => Promise<EventEmitResponse>;
  /**
   * Callback for relaying concurrency.report from the sandbox to the orchestrator.
   * Returns the orchestrator's ack (proceed/wait/cancel).
   */
  onConcurrencyReport: (report: ConcurrencyReportMessage) => Promise<ConcurrencyAckMessage>;
  /**
   * Callback for relaying agent.api.request from the sandbox to the orchestrator.
   * Returns the orchestrator's response (result or error).
   *
   * Optional for backward compatibility (callers that don't support the agent API).
   */
  onApiRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Callback for relaying a user-facing cache request from the sandbox to the
   * orchestrator. The sandbox runner sends `cache.request` IPC; the agent wraps
   * it in the matching `cache.user.*` WS message and forwards to the
   * orchestrator. Returns the orchestrator's response (or an error response).
   *
   * Optional so backends / harnesses that don't thread the cache through keep
   * working — the runner falls back to a "not configured" cache response.
   */
  onCacheRequest?: (request: CacheRequestIpc) => Promise<CacheResponseIpc>;
  /**
   * Callback for opening or closing a git write grant on behalf of the sandbox.
   *
   * The grant lives in the AGENT's grant table because the credential helper
   * git spawns is a separate process that consults the agent, not the sandbox
   * runner. Optional so harnesses that don't thread git credentials keep
   * working — the runner falls back to a "not configured" error response.
   */
  onGitGrantRequest?: (request: GitGrantRequestIpc) => Promise<GitGrantResponseIpc>;
  /**
   * Absolute path to the agent's git credential helper.
   *
   * Threaded into the execution request so the runner configures it on every
   * clone. Set for the bare-metal (fork) backend, whose runner is a host
   * process that can reach the agent's socket. Deliberately NOT set by the
   * container backend: git runs inside the container and has no route to it —
   * see the dual-mode container work.
   */
  credentialHelperPath?: string;
  /**
   * Callback for relaying a provenance bundle upload request from the sandbox to
   * the orchestrator. The sandbox runner sends `provenance.request` IPC; the
   * agent wraps it in the matching `provenance.upload.*` WS message and forwards
   * to the orchestrator. Optional so harnesses that don't thread provenance keep
   * working — the runner falls back to a "not configured" error response.
   */
  onProvenanceRequest?: (request: ProvenanceRequestIpc) => Promise<ProvenanceResponseIpc>;
  /**
   * Callback for relaying a user-facing artifact request from the sandbox to the
   * orchestrator. The sandbox runner sends `artifacts.request` IPC; the agent
   * wraps it in the matching `artifacts.upload.*` / `artifacts.download.*` WS
   * message and forwards to the orchestrator. Optional so harnesses that don't
   * thread artifacts keep working — the runner falls back to a "not configured"
   * error response.
   */
  onArtifactRequest?: (request: ArtifactRequestIpc) => Promise<ArtifactResponseIpc>;
  /**
   * Callback for relaying a step-level approval request from the sandbox to the
   * orchestrator. The sandbox runner sends `approval.request` IPC; the agent
   * wraps it in a `step.approval-request` WS message and forwards to the
   * orchestrator, awaiting the `step.approval-resolved` response which it pipes
   * back as `approval.resolved`. Optional so harnesses that don't thread
   * approvals keep working — the runner falls back to a fail-closed reject.
   */
  onApprovalRequest?: (request: StepApprovalRequestIpc) => Promise<StepApprovalResolvedIpc>;
  /**
   * Callback fired once per `ctx.secrets.mountFile` / `exposeFile` call the
   * workflow runner performs. Carries only key names + the resulting path /
   * env var -- never the file content. Optional so backends that don't yet
   * thread the event through (CT / unit-style harnesses) keep working.
   */
  onSecretMount?: (event: {
    stepIndex: number;
    sources: string[];
    target: string;
    envVar?: string;
    kind: 'mountFile' | 'exposeFile';
  }) => void;
}

// --- Job execution result ---

/** Aggregated result of a job execution. */
export interface JobExecutionResult {
  /** Overall job status. */
  status: 'success' | 'failed' | 'cancelled';
  /** Per-step results in execution order. */
  stepResults: SandboxStepResult[];
  /** Total job duration in milliseconds. */
  durationMs: number;
  /** Error message when the runner process crashed (no job.complete received). */
  error?: string;
  /** Aggregated step outputs by step name (present on success when steps return values). */
  outputs?: Record<string, Record<string, unknown>>;
  /** Encrypted secret outputs (present on success when steps called ctx.setSecretOutput). */
  secretOutputs?: Record<string, { agentPublicKey: string; encrypted: string }>;
  /** Names of sibling jobs dropped by DynamicJobFn re-evaluation drift. */
  droppedJobs?: string[];
}

// --- Per-step result ---

/**
 * Result of a single step execution within the sandbox.
 *
 * Self-contained step result type for the sandbox execution model.
 */
export interface SandboxStepResult {
  /** Step name from the workflow definition. */
  name: string;
  /** Zero-based index of the step within the job. */
  stepIndex: number;
  /** Step execution status. `cancelled` = a parallel sibling fail-fast cancel. */
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  /** Step duration in milliseconds. */
  durationMs: number;
  /** Error details when status is 'failed'. */
  error?: {
    /** Human-readable error message. */
    message: string;
    /** Process exit code (non-zero on failure). */
    exitCode?: number;
    /** Signal that terminated the process (e.g. 'SIGTERM', 'SIGKILL'). */
    signal?: string;
  };
  /** Step return value (outputs). Present on success when step returns non-void. */
  outputs?: Record<string, unknown>;
}
