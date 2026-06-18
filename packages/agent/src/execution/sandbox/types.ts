import type { JobDispatch } from '@kici-dev/engine';
import type {
  EventEmitRequest,
  EventEmitResponse,
  ConcurrencyReportMessage,
  ConcurrencyAckMessage,
  CacheRequestIpc,
  CacheResponseIpc,
  ProvenanceRequestIpc,
  ProvenanceResponseIpc,
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
  /** Callback for real-time log line forwarding. */
  onLogLine: (stepIndex: number, line: string) => void;
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
   * Callback for relaying a provenance bundle upload request from the sandbox to
   * the orchestrator. The sandbox runner sends `provenance.request` IPC; the
   * agent wraps it in the matching `provenance.upload.*` WS message and forwards
   * to the orchestrator. Optional so harnesses that don't thread provenance keep
   * working — the runner falls back to a "not configured" error response.
   */
  onProvenanceRequest?: (request: ProvenanceRequestIpc) => Promise<ProvenanceResponseIpc>;
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
  /** Step execution status. */
  status: 'success' | 'failed' | 'skipped';
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
