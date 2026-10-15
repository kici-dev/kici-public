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
 * Common interface for the container, bare-metal and Firecracker backends.
 * Lifecycle: setup -> executeJob -> teardown, with abort available at any time.
 *
 * The sandbox isolates customer code from agent-internal credentials and
 * resources. The agent process never loads or executes customer code directly.
 */
export interface ExecutionSandbox {
  /**
   * - Container: create + start disposable container
   * - Bare-metal: validate bwrap availability
   * - Firecracker: no-op (VM already running, managed by scaler)
   */
  setup(options: SandboxSetupOptions): Promise<void>;

  /**
   * Runs clone, dependency install, compile and steps inside the sandbox,
   * reporting step results via callbacks as they complete.
   */
  executeJob(options: JobExecutionOptions): Promise<JobExecutionResult>;

  /**
   * Ask the runner to stop (abort IPC / SIGTERM), wait a backend-specific grace
   * period (container 10s, bare-metal 30s default), then force-kill.
   */
  abort(): Promise<void>;

  /**
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

export interface SandboxSetupOptions {
  /** Container backend only, e.g. 'node:20-alpine'. */
  image?: string;
  /** Host working directory for the job. */
  workDir: string;
  /** Sanitized env (user env + secrets, NO agent credentials). */
  env: Record<string, string>;
  /**
   * Extra read-only host paths beyond the workspace + runner: the `file://`
   * clone-source dir(s) the in-sandbox `git clone` reads. The job-runner derives
   * them from the dispatch `repoUrl` (empty for https/ssh remotes). The container
   * backend binds each as `<dir>:<dir>:ro`; bare-metal derives its own inside
   * `executeJob` and ignores this field.
   */
  extraReadOnlyBinds?: string[];
  /**
   * Populate the sandbox workspace from `workDir` (the AGENT already cloned on
   * the host) instead of cloning inside it. The container backend packs
   * `workDir` into the container's `/workspace` volume; bare-metal already runs
   * against `workDir` and ignores it.
   *
   * Cloning on the host lets a container image ship without git, and keeps
   * clone-time credentials on the host, where the credential helper works,
   * instead of needing a route into a hardened container.
   */
  workspaceFromHost?: boolean;
}

// --- Job execution options ---

export interface JobExecutionOptions {
  /** Orchestrator dispatch data (repo URL, ref, sha, token, etc.). */
  dispatch: JobDispatch;
  /** Real-time step status updates (start, success, failed). */
  onStepStatus: (
    stepIndex: number,
    name: string,
    state: string,
    data?: Record<string, unknown>,
  ) => void;
  /** Real-time log line forwarding. `stream` absent means stdout. */
  onLogLine: (stepIndex: number, line: string, stream?: LogStream) => void;
  signal: AbortSignal;
  /** Relays sandbox `event.emit` IPC to the orchestrator over WS and returns its response. */
  onEventEmit: (request: EventEmitRequest) => Promise<EventEmitResponse>;
  /** Relays `concurrency.report` and returns the orchestrator's ack (proceed/wait/cancel). */
  onConcurrencyReport: (report: ConcurrencyReportMessage) => Promise<ConcurrencyAckMessage>;
  /**
   * Relays `agent.api.request` and returns the orchestrator's result or error.
   * Optional for callers that don't support the agent API.
   */
  onApiRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Relays `cache.request` IPC as the matching `cache.user.*` WS message.
   * Absent → the runner falls back to a "not configured" cache response.
   */
  onCacheRequest?: (request: CacheRequestIpc) => Promise<CacheResponseIpc>;
  /**
   * Opens or closes a git write grant on behalf of the sandbox. The grant lives
   * in the AGENT's grant table because the credential helper git spawns is a
   * separate process that consults the agent, not the sandbox runner.
   * Absent → the runner falls back to a "not configured" error response.
   */
  onGitGrantRequest?: (request: GitGrantRequestIpc) => Promise<GitGrantResponseIpc>;
  /**
   * Absolute path to the agent's git credential helper, configured by the
   * runner on every clone. Set for the bare-metal (fork) backend, whose runner
   * is a host process that can reach the agent's socket. Deliberately NOT set by
   * the container backend: git runs inside the container and has no route to it.
   */
  credentialHelperPath?: string;
  /**
   * Operator opt-out from `--ignore-scripts` on the `.kici/` dependency install
   * (`KICI_ALLOW_INSTALL_SCRIPTS`). Sourced from agent config only, so a
   * dispatch payload or a workflow cannot re-enable lifecycle scripts.
   */
  allowInstallScripts?: boolean;
  /**
   * Relays `provenance.request` IPC as the matching `provenance.upload.*` WS message.
   * Absent → the runner falls back to a "not configured" error response.
   */
  onProvenanceRequest?: (request: ProvenanceRequestIpc) => Promise<ProvenanceResponseIpc>;
  /**
   * Relays `artifacts.request` IPC as the matching `artifacts.upload.*` /
   * `artifacts.download.*` WS message. Absent → the runner falls back to a
   * "not configured" error response.
   */
  onArtifactRequest?: (request: ArtifactRequestIpc) => Promise<ArtifactResponseIpc>;
  /**
   * Relays `approval.request` IPC as a `step.approval-request` WS message and
   * pipes the `step.approval-resolved` response back as `approval.resolved`.
   * Absent → the runner falls back to a fail-closed reject.
   */
  onApprovalRequest?: (request: StepApprovalRequestIpc) => Promise<StepApprovalResolvedIpc>;
  /**
   * Fired once per `ctx.secrets.mountFile` / `exposeFile` call. Carries only
   * key names + the resulting path / env var, never the file content. Optional
   * for backends that don't thread the event through (CT / unit-style harnesses).
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

export interface JobExecutionResult {
  status: 'success' | 'failed' | 'cancelled';
  /** In execution order. */
  stepResults: SandboxStepResult[];
  durationMs: number;
  /** Set when the runner process crashed (no job.complete received). */
  error?: string;
  /** Step outputs by step name (present on success when steps return values). */
  outputs?: Record<string, Record<string, unknown>>;
  /** Present on success when steps called ctx.setSecretOutput. */
  secretOutputs?: Record<string, { agentPublicKey: string; encrypted: string }>;
  /** Names of sibling jobs dropped by DynamicJobFn re-evaluation drift. */
  droppedJobs?: string[];
}

// --- Per-step result ---

export interface SandboxStepResult {
  name: string;
  /** Zero-based index of the step within the job. */
  stepIndex: number;
  /** `cancelled` = a parallel sibling fail-fast cancel. */
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  durationMs: number;
  /** Set when status is 'failed'. */
  error?: {
    message: string;
    /** Process exit code (non-zero on failure). */
    exitCode?: number;
    /** Signal that terminated the process (e.g. 'SIGTERM', 'SIGKILL'). */
    signal?: string;
  };
  /** Step return value. Present on success when the step returns non-void. */
  outputs?: Record<string, unknown>;
}
