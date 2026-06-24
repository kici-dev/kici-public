import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import Docker from 'dockerode';
import type {
  AgentToOrchestratorMessage,
  JobDispatch,
  JobStatus,
  AgentStepStatus,
} from '@kici-dev/engine';
import {
  ExecutionJobStatus,
  ExecutionStepStatus,
  InitFailureCategory,
  CacheStepType,
  CacheRunEventType,
} from '@kici-dev/engine';
import type { AppConfig } from '../config.js';
import { gitClone } from '../checkout/git-clone.js';
import { loadWorkflowSource, extractWorkflow } from './workflow-loader.js';
import { packKiciSource } from './source-packer.js';
import { restoreSource } from './source-restore.js';
import { evaluateDynamicFields } from './init-runner.js';
import { withTimeout } from './timeout-util.js';
import { serializeJobsToLock, MatrixExpansionError } from './dynamic-job-serializer.js';
import { buildKiciApi, buildNeedsContext } from '@kici-dev/sdk';
import type { EventPayload, DynamicJobNeed } from '@kici-dev/sdk';
import { LogStreamer } from './log-streamer.js';
import { runCaptured, type CaptureSink } from './console-capture.js';
import { applyOverlay } from './overlay-applier.js';
import { installDeps } from './dep-installer.js';
import { restoreDeps } from './dep-restore.js';
import { packNodeModules } from './dep-packer.js';
import { uploadToPresignedUrl } from './download.js';
import { createLogger, getRequestContext, toErrorMessage } from '@kici-dev/shared';
import type {
  ExecutionSandbox,
  JobExecutionResult,
  CacheRequestIpc,
  CacheResponseIpc,
  ProvenanceRequestIpc,
  ProvenanceResponseIpc,
  StepApprovalRequestIpc,
  StepApprovalResolvedIpc,
} from './sandbox/index.js';
import {
  BareMetalSandbox,
  ContainerSandbox,
  FirecrackerSandbox,
  buildSanitizedEnv,
} from './sandbox/index.js';
import { stepsTotal, stepDurationSeconds, cloneDurationSeconds } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'job-runner' });

/**
 * Check if a file exists at the given path.
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dependencies injected into JobRunner.
 */
export interface JobRunnerDeps {
  /** Send function for WS messages (buffered) */
  send: (msg: AgentToOrchestratorMessage) => void;
  /** Send direct function (bypasses buffer, for protocol messages) */
  sendDirect: (msg: AgentToOrchestratorMessage) => void;
  /** Agent config */
  config: AppConfig;
  /** Request a pre-signed S3 upload URL from the orchestrator via WS request-response. */
  requestUploadUrl: (
    jobId: string,
    cacheType: 'source' | 'deps',
    key: { contentHash?: string; lockfileHash?: string; platform: string; arch: string },
  ) => Promise<string>;
  /** Notify orchestrator that an S3 upload is complete (for metadata initialization). */
  sendUploadComplete: (
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      platform: string;
      arch: string;
      depsHash?: string;
    },
  ) => void;
  /**
   * Send an event.emit WS message to the orchestrator and await the response.
   * Used to relay ctx.emit() from the sandbox through the WS connection.
   */
  sendEventEmit: (
    jobId: string,
    requestId: string,
    eventName: string,
    payload: Record<string, unknown>,
    target?: { repos?: string[] },
  ) => Promise<{ requestId: string; deliveryId?: string; error?: string }>;
  /** Get WS send buffer size in bytes. Used by LogStreamer for backpressure detection. */
  getBufferedAmount?: () => number;
  /** Register a one-time callback for the WS 'drain' event. */
  onDrain?: (callback: () => void) => void;
  /**
   * Send a job.context message to the orchestrator with execution environment details.
   */
  sendJobContext: (
    runId: string,
    jobId: string,
    context: {
      envVars?: Array<{
        name: string;
        value: string;
        category: 'system' | 'user' | 'inherited' | 'secret';
      }>;
      runtime?: { nodeVersion?: string; os?: string; arch?: string };
      sandboxType?: string;
      labels?: string[];
      workingDirectory?: string;
      gitRef?: string;
    },
  ) => void;
  /**
   * Send a run.event message to the orchestrator for infrastructure lifecycle tracking.
   */
  sendRunEvent: (
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ) => void;
  /**
   * Send a job.concurrency.report WS message and wait for job.concurrency.ack.
   * Returns the orchestrator's ack with action (proceed/wait/cancel).
   */
  sendConcurrencyReport: (
    runId: string,
    jobId: string,
    group: string,
  ) => Promise<{ action: 'proceed' | 'wait' | 'cancel'; reason?: string }>;
  /**
   * Send an agent.api.request WS message and await the response.
   * Used to relay kici.* API calls from the sandbox through the WS connection.
   * Optional for backward compatibility.
   */
  sendApiRequest?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Relay a user-facing cache request to the orchestrator and await the
   * response. Translates the sandbox `cache.request` IPC into the matching
   * `cache.user.restore.request` / `cache.user.save.request` /
   * `cache.user.save.complete` WS message and returns the orchestrator's
   * `cache.user.*.response` mapped back onto the IPC response shape.
   * Optional for backward compatibility (callers that don't support the cache).
   */
  requestUserCache?: (jobId: string, request: CacheRequestIpc) => Promise<CacheResponseIpc>;
  /**
   * Relay a provenance bundle upload operation to the orchestrator and await the
   * response. Translates the sandbox `provenance.request` IPC into the matching
   * `provenance.upload.request` / `.complete` WS message. Optional for backward
   * compatibility (callers that don't support provenance).
   */
  relayProvenance?: (
    jobId: string,
    request: ProvenanceRequestIpc,
  ) => Promise<ProvenanceResponseIpc>;
  /**
   * Relay a step-level approval request to the orchestrator and await the
   * resolution. Translates the sandbox `approval.request` IPC into a
   * `step.approval-request` WS message and returns the orchestrator's
   * `step.approval-resolved` mapped onto the IPC response shape. Optional for
   * backward compatibility (callers that don't support approvals).
   */
  sendStepApproval?: (
    runId: string,
    jobId: string,
    request: StepApprovalRequestIpc,
  ) => Promise<StepApprovalResolvedIpc>;
}

interface ActiveJob {
  abortController: AbortController;
  completionPromise: Promise<void>;
  runId: string;
}

/**
 * Job-config shape for build-only jobs.
 *
 * Build jobs install dependencies, optionally pack a deps tarball
 * and a source tarball, and report status. They do not execute workflow steps.
 * Mirror of the orchestrator-side build-job dispatch payload.
 */
interface BuildJobConfig {
  buildOnly: true;
  contentHash?: string;
  lockfileHash?: string;
  buildSourceNeeded?: boolean;
  buildDepsNeeded?: boolean;
  workflowName: string;
  resolvedHashFiles?: string[];
}

/**
 * Execution mode for the sandbox backend.
 *
 * Determined by KICI_EXECUTION_MODE env var or container config in job dispatch:
 * - 'container': Run inside a disposable Docker/Podman container (strongest isolation)
 * - 'bare-metal': Run as a child process on the host with env sanitization
 * - 'firecracker': Run as a child process inside a Firecracker VM (defense-in-depth)
 */
type ExecutionMode = 'container' | 'bare-metal' | 'firecracker';

/**
 * Resolve the absolute path to the compiled workflow-runner.js entry point.
 *
 * The runner is a separate rolldown entry point. Its location depends on the
 * build mode:
 * - Bundle mode (build-service.mjs): dist/workflow-runner.js (flat alongside server.js)
 * - Library mode (build-ts.mjs): dist/execution/sandbox/workflow-runner.js
 * - Library mode chunked: dist/ with chunks, runner at execution/sandbox/workflow-runner.js
 *
 * We try all possible locations.
 */
function resolveRunnerPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Bundle mode: __dirname is dist/, runner is a sibling entry point
  const bundlePath = join(__dirname, 'workflow-runner.js');
  if (existsSync(bundlePath)) return bundlePath;
  // Library mode: __dirname is dist/execution/, runner is at ./sandbox/workflow-runner.js
  const originalPath = join(__dirname, 'sandbox', 'workflow-runner.js');
  if (existsSync(originalPath)) return originalPath;
  // Library mode chunked: __dirname is dist/, runner is at ./execution/sandbox/workflow-runner.js
  const chunkedPath = join(__dirname, 'execution', 'sandbox', 'workflow-runner.js');
  if (existsSync(chunkedPath)) return chunkedPath;
  // Fallback: return bundle path and let the caller handle the error
  return bundlePath;
}

/**
 * Determine the execution mode from agent config and job config.
 *
 * Priority:
 * 1. Container config in job dispatch -> 'container'
 * 2. config.executionMode (KICI_EXECUTION_MODE) -> explicit override
 * 3. config.scalerManaged (KICI_SCALER_MANAGED=1) with Firecracker detection -> 'firecracker'
 * 4. Default -> 'bare-metal'
 */
function determineExecutionMode(
  jobConfig: Record<string, unknown>,
  agentConfig: Pick<AppConfig, 'executionMode' | 'scalerManaged'>,
): ExecutionMode {
  // Container config in job dispatch takes highest priority
  const containerConfig = jobConfig.container;
  if (containerConfig) {
    return 'container';
  }

  // Explicit config override (KICI_EXECUTION_MODE)
  if (agentConfig.executionMode) {
    return agentConfig.executionMode;
  }

  // Firecracker agents run inside VMs managed by the scaler
  if (agentConfig.scalerManaged) {
    return 'firecracker';
  }

  // Default: bare-metal
  return 'bare-metal';
}

/**
 * Build the result-aware `ctx.needs` for a dynamic eval from its frozen upstream
 * snapshot. Returns undefined for an event-only generator (no snapshot).
 */
export function buildEvalNeedsContext(config: {
  resultAware?: boolean;
  declaredNeeds?: readonly unknown[];
  upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot;
}): ReturnType<typeof buildNeedsContext> | undefined {
  if (!config.resultAware || !config.upstreamSnapshot) return undefined;
  return buildNeedsContext(
    config.upstreamSnapshot,
    (config.declaredNeeds ?? []) as ReadonlyArray<DynamicJobNeed>,
  );
}

/**
 * Top-level job execution orchestrator for the agent.
 *
 * When a `job.dispatch` is received, the runner:
 * 1. Creates a temp work directory
 * 2. Selects the appropriate sandbox backend (container, bare-metal, firecracker)
 * 3. Delegates execution to the sandbox (clone, compile, run steps)
 * 4. Wires sandbox IPC callbacks to the WS message pipeline
 * 5. Reports status (running -> success/failed/cancelled/skipped)
 * 6. Cleans up work directory and sandbox
 *
 * Customer code runs in an isolated child process -- NEVER in the agent's V8 isolate.
 * Build jobs still run in-process (they don't execute customer workflow steps).
 */
export class JobRunner {
  private readonly send: (msg: AgentToOrchestratorMessage) => void;
  private readonly sendDirect: (msg: AgentToOrchestratorMessage) => void;
  private readonly config: AppConfig;
  private readonly requestUploadUrl: JobRunnerDeps['requestUploadUrl'];
  private readonly sendUploadComplete: JobRunnerDeps['sendUploadComplete'];
  private readonly sendEventEmit: JobRunnerDeps['sendEventEmit'];
  private readonly getBufferedAmount?: () => number;
  private readonly onDrain?: (callback: () => void) => void;
  private readonly _sendJobContext: JobRunnerDeps['sendJobContext'];
  private readonly _sendRunEvent: JobRunnerDeps['sendRunEvent'];
  private readonly _sendConcurrencyReport: JobRunnerDeps['sendConcurrencyReport'];
  private readonly _sendApiRequest?: JobRunnerDeps['sendApiRequest'];
  private readonly _requestUserCache?: JobRunnerDeps['requestUserCache'];
  private readonly _relayProvenance?: JobRunnerDeps['relayProvenance'];
  private readonly _sendStepApproval?: JobRunnerDeps['sendStepApproval'];

  /** Tracks running jobs for concurrency and cancellation */
  readonly activeJobs = new Map<string, ActiveJob>();

  /** Active sandbox for the current job (used for abort). */
  private activeSandbox: ExecutionSandbox | null = null;

  constructor(deps: JobRunnerDeps) {
    this.send = deps.send;
    this.sendDirect = deps.sendDirect;
    this.config = deps.config;
    this.requestUploadUrl = deps.requestUploadUrl;
    this.sendUploadComplete = deps.sendUploadComplete;
    this.sendEventEmit = deps.sendEventEmit;
    this.getBufferedAmount = deps.getBufferedAmount;
    this.onDrain = deps.onDrain;
    this._sendJobContext = deps.sendJobContext;
    this._sendRunEvent = deps.sendRunEvent;
    this._sendConcurrencyReport = deps.sendConcurrencyReport;
    this._sendApiRequest = deps.sendApiRequest;
    this._requestUserCache = deps.requestUserCache;
    this._relayProvenance = deps.relayProvenance;
    this._sendStepApproval = deps.sendStepApproval;
  }

  /**
   * Execute a dispatched job through its full lifecycle.
   *
   * Creates a temp directory, delegates to the appropriate sandbox,
   * reports status, and cleans up.
   */
  async execute(dispatch: JobDispatch): Promise<void> {
    const { runId: _runId, jobId, jobConfig: _jobConfig } = dispatch;
    const abortController = new AbortController();

    // Create temp work directory
    const workDir = await fs.mkdtemp(join(tmpdir(), 'kici-'));

    // Track this job
    const completionPromise = this.runJob(dispatch, workDir, abortController).finally(async () => {
      this.activeJobs.delete(jobId);
      this.activeSandbox = null;
      // Always clean up work directory
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    });

    this.activeJobs.set(jobId, { abortController, completionPromise, runId: dispatch.runId });

    return completionPromise;
  }

  /**
   * Cancel a running job by signaling its abort controller
   * and aborting the active sandbox.
   *
   * @param force When true, force-cancel (SIGKILL, skip hooks). When false, graceful cancel.
   */
  cancel(jobId: string, reason: string, _force: boolean = false): void {
    const active = this.activeJobs.get(jobId);
    if (!active) return;

    active.abortController.abort(reason);

    // Also abort the sandbox directly for graceful shutdown
    if (this.activeSandbox) {
      this.activeSandbox.abort().catch(() => {});
    }
  }

  /**
   * Internal job execution pipeline.
   *
   * For execution jobs: delegates to an ExecutionSandbox (customer code in
   * isolated child process). For build-only jobs: runs in-process (no customer
   * workflow steps).
   */
  private async runJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    // Phase 1: Special-cased job types (init / dynamicJobFn / build) short-circuit
    // before the standard sandbox pipeline.
    if (await this.dispatchSpecialJobType(dispatch, workDir, abortController)) {
      return;
    }

    // Phase 2: Standard execution job — sandbox lifecycle.
    await this.executeStandardJob(dispatch, workDir, abortController);
  }

  /**
   * Route init-only / dynamicJobFn / build-only jobs to their dedicated handlers.
   *
   * Returns `true` when one of the special handlers ran (caller must early-return);
   * `false` when the job is a standard execution job that should hit the sandbox path.
   */
  private async dispatchSpecialJobType(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<boolean> {
    const { runId, jobId, jobConfig } = dispatch;

    // Check for init-only jobs (dynamic field resolution, handled before build/execution)
    const isInitOnly = (jobConfig as { initOnly?: boolean }).initOnly === true;
    if (isInitOnly) {
      await this.handleInitJob(dispatch, workDir, abortController);
      return true;
    }

    // Check for DynamicJobFn evaluation jobs (runtime job generation)
    const isDynamicJobFnEval = (jobConfig as { dynamicJobFn?: boolean }).dynamicJobFn === true;
    if (isDynamicJobFnEval) {
      await this.handleDynamicJobFn(dispatch, workDir, abortController);
      return true;
    }

    // Check for build-only jobs (handled separately from execution jobs)
    const isBuildOnly = (jobConfig as { buildOnly?: boolean }).buildOnly === true;
    if (isBuildOnly) {
      // Build jobs are not dispatched for fullRepo runs, but guard defensively
      if ((jobConfig as { fullRepo?: boolean }).fullRepo) {
        logger.warn('Build job received for fullRepo run -- skipping (should not happen)', {
          jobId,
          runId,
        });
        this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success);
        return true;
      }
      await this.handleBuildJob(dispatch, workDir, abortController);
      return true;
    }

    return false;
  }

  /**
   * Run a standard execution job through its full sandbox lifecycle.
   *
   * Heartbeat timer + try/finally wrap sandbox creation, setup, execution, and
   * teardown. Errors during execution are caught and reported as a failed job
   * status; the sandbox is always torn down in the finally block.
   */
  private async executeStandardJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId } = dispatch;

    // Print trace header once per job (per locked decision)
    const ctx = getRequestContext();
    logger.info(`Run: ${ctx.runId ?? runId} | Trace: ${ctx.requestId ?? 'N/A'}`);

    // Send running status
    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    // Start per-job heartbeat timer for stale run detection
    const heartbeatTimer = setInterval(() => {
      this.send({
        type: 'job.heartbeat',
        runId,
        jobId,
        timestamp: Date.now(),
      });
    }, this.config.jobHeartbeatIntervalMs);

    // Create sandbox for this job
    let sandbox: ExecutionSandbox | undefined;

    try {
      const setupResult = await this.setupSandboxForExecution(dispatch, workDir, abortController);
      if (!setupResult) {
        // Aborted during setup — cancellation status was already sent.
        return;
      }
      sandbox = setupResult.sandbox;

      const { result, logStreamers } = await this.runSandboxExecution(
        dispatch,
        sandbox,
        abortController,
      );

      this.reportExecutionResult(dispatch, result, logStreamers);
    } catch (error) {
      // Unexpected error in job execution
      const errorMsg = toErrorMessage(error);
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, {
        error: errorMsg,
      });
    } finally {
      clearInterval(heartbeatTimer);
      // Always tear down the sandbox
      if (sandbox) {
        this.emitRunEvent(runId, 'agent.teardown', { jobId });
        await sandbox.teardown().catch((err) => {
          logger.warn('Sandbox teardown error', {
            error: toErrorMessage(err),
          });
        });
      }
    }
  }

  /**
   * Determine execution mode, build sanitized env, create + setup the sandbox,
   * and emit the job.context message.
   *
   * Returns `null` if the abort signal fires before / during setup (the caller
   * has already received a `cancelled` status via `sendJobStatus`).
   */
  private async setupSandboxForExecution(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<{ sandbox: ExecutionSandbox; sanitizedEnv: Record<string, string> } | null> {
    const { runId, jobId, jobConfig } = dispatch;

    // Check for abort before sandbox creation
    if (abortController.signal.aborted) {
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
      return null;
    }

    // Step 1: Determine execution mode and create appropriate sandbox
    const executionMode = determineExecutionMode(jobConfig as Record<string, unknown>, {
      executionMode: this.config.executionMode,
      scalerManaged: this.config.scalerManaged,
    });
    const runnerPath = resolveRunnerPath();
    // Secrets are NOT injected into env vars -- they flow through IPC to ctx.secrets.
    const typedConfig = jobConfig as Record<string, unknown>;
    const sanitizedEnv = buildSanitizedEnv((typedConfig.env as Record<string, string>) ?? {}, {
      environmentVars: (typedConfig.environmentVars as Record<string, string>) ?? undefined,
      jobEnv: (typedConfig.jobEnv as Record<string, string>) ?? undefined,
    });

    logger.info('Creating execution sandbox', { executionMode, jobId, runnerPath });

    const sandbox = this.createSandbox(executionMode, {
      runnerPath,
      env: sanitizedEnv,
      jobId,
      jobConfig: jobConfig as Record<string, unknown>,
    });

    this.activeSandbox = sandbox;

    // Step 2: Setup sandbox (container: create + start; bare-metal: validate)
    await sandbox.setup({ workDir, env: sanitizedEnv });

    if (abortController.signal.aborted) {
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
      return null;
    }

    // Emit job.context with execution environment details
    this._sendJobContext(runId, jobId, {
      runtime: {
        nodeVersion: process.version,
        os: os.platform(),
        arch: os.arch(),
      },
      sandboxType: executionMode,
      workingDirectory: workDir,
      gitRef: dispatch.ref,
      envVars: this.collectEnvVars(sanitizedEnv),
    });

    return { sandbox, sanitizedEnv };
  }

  /**
   * Drive `sandbox.executeJob` with IPC callbacks wired to the WS pipeline.
   *
   * Lazily creates per-step LogStreamers, forwards step + log + event-emit +
   * concurrency-report + api-request messages, and emits the
   * `agent.execution.start` / `agent.execution.end` lifecycle events.
   */
  private async runSandboxExecution(
    dispatch: JobDispatch,
    sandbox: ExecutionSandbox,
    abortController: AbortController,
  ): Promise<{ result: JobExecutionResult; logStreamers: Map<number, LogStreamer> }> {
    const { runId, jobId } = dispatch;

    // Step 3: Manage LogStreamers lazily per step
    const logStreamers = new Map<number, LogStreamer>();
    const maxLogSizeBytes = dispatch.maxLogSizeBytes ?? this.config.maxLogSizeBytes;

    const getOrCreateLogStreamer = (stepIndex: number): LogStreamer => {
      let streamer = logStreamers.get(stepIndex);
      if (!streamer) {
        streamer = new LogStreamer({
          send: (msg) => this.send(msg),
          runId,
          jobId,
          stepIndex,
          maxLogSizeBytes,
          // Backpressure wiring: enables LogStreamer to detect WS buffer pressure
          // and apply pause/drop strategy based on agent config.
          // onBackpressure/onBackpressureClear are intentionally unwired — the sandbox
          // IPC boundary prevents direct stdout.pause()/resume() control, so LogStreamer
          // handles backpressure internally by buffering (pause) or dropping (drop).
          // Observability: LogStreamer increments kici_agent_log_backpressure_events_total,
          // kici_agent_log_backpressure_active, and kici_agent_log_lines_dropped_total
          // on rising edges / drop events, so operators can see pressure without callbacks.
          getBufferedAmount: this.getBufferedAmount,
          backpressureMode: this.config.backpressureMode,
          onWsDrain: this.onDrain,
        });
        logStreamers.set(stepIndex, streamer);
      }
      return streamer;
    };

    // Emit agent.execution.start event
    const executionStartMs = Date.now();
    this.emitRunEvent(runId, 'agent.execution.start', { jobId });

    // Step 4: Execute job via sandbox with IPC callbacks wired to WS pipeline
    const result: JobExecutionResult = await sandbox.executeJob({
      dispatch,
      onStepStatus: (stepIndex, stepName, state, data) => {
        // On terminal step states, look up the per-step LogStreamer (created
        // lazily by onLogLine) and forward the raw byte total. The
        // orchestrator accumulates these into per-job + per-run totals on
        // execution_jobs.log_bytes / execution_runs.log_bytes.
        let logBytesStreamed: number | undefined;
        if (
          state === ExecutionStepStatus.enum.success ||
          state === ExecutionStepStatus.enum.failed ||
          state === ExecutionStepStatus.enum.skipped
        ) {
          const streamer = logStreamers.get(stepIndex);
          logBytesStreamed = streamer?.getTotalBytes() ?? 0;
        }
        // A cache pseudo-step (`cache:restore` / `cache:save`) also emits a
        // `run.event` carrying its outcome so the run timeline records cache
        // hit/miss/saved alongside the step status — same treatment hooks get.
        this.maybeEmitCacheRunEvent(runId, jobId, stepIndex, state, data);
        this.sendStepStatus(dispatch, stepIndex, stepName, state, data, logBytesStreamed);
      },
      onLogLine: (stepIndex, line) => {
        const streamer = getOrCreateLogStreamer(stepIndex);
        streamer.addLine(line);
      },
      signal: abortController.signal,
      // Wire event.emit relay: sandbox runner -> agent WS -> orchestrator
      onEventEmit: async (request) => {
        const response = await this.sendEventEmit(
          jobId,
          request.requestId,
          request.eventName,
          request.payload,
          request.target,
        );
        return {
          type: 'event.emit.response' as const,
          requestId: response.requestId,
          deliveryId: response.deliveryId,
          error: response.error,
        };
      },
      // Wire concurrency report relay: sandbox runner -> agent WS -> orchestrator
      onConcurrencyReport: async (report) => {
        const ack = await this._sendConcurrencyReport(dispatch.runId, dispatch.jobId, report.group);
        return {
          type: 'concurrency.ack' as const,
          action: ack.action,
          reason: ack.reason,
        };
      },
      onApiRequest: this._sendApiRequest
        ? async (method, params) => this._sendApiRequest!(method, params)
        : undefined,
      // Wire user-cache relay: sandbox runner -> agent WS -> orchestrator
      onCacheRequest: this._requestUserCache
        ? async (request) => this._requestUserCache!(jobId, request)
        : undefined,
      onProvenanceRequest: this._relayProvenance
        ? async (request) => this._relayProvenance!(jobId, request)
        : undefined,
      // Wire step-approval relay: sandbox runner -> agent WS -> orchestrator
      onApprovalRequest: this._sendStepApproval
        ? async (request) => this._sendStepApproval!(dispatch.runId, dispatch.jobId, request)
        : undefined,
      // Wire secret-mount audit events: sandbox runner -> agent -> orchestrator
      // The orchestrator persists these alongside `secretsAccessed` (see
      // execution-tracker.ts -- onStepStatusForward path).
      onSecretMount: (event) => {
        this.emitRunEvent(runId, 'step.secret_mount', {
          jobId,
          metadata: {
            stepIndex: event.stepIndex,
            sources: event.sources,
            target: event.target,
            kind: event.kind,
            ...(event.envVar !== undefined && { envVar: event.envVar }),
          },
        });
      },
    });

    // Emit agent.execution.end event with duration
    this.emitRunEvent(runId, 'agent.execution.end', {
      jobId,
      durationMs: Date.now() - executionStartMs,
      metadata: { status: result.status },
    });

    return { result, logStreamers };
  }

  /**
   * Tear down log streamers, record step Prometheus metrics, log sandbox
   * failure diagnostics, and send the terminal `job.status` message.
   */
  private reportExecutionResult(
    dispatch: JobDispatch,
    result: JobExecutionResult,
    logStreamers: Map<number, LogStreamer>,
  ): void {
    // Step 5: Destroy all log streamers before reporting final status.
    // destroy() force-sends remaining buffer (bypassing backpressure) and cleans up timers.
    for (const streamer of logStreamers.values()) {
      streamer.destroy();
    }

    // Step 5b: Record Prometheus metrics for step execution
    for (const stepResult of result.stepResults) {
      stepsTotal.add(1, { status: stepResult.status });
      if (stepResult.durationMs > 0) {
        stepDurationSeconds.record(stepResult.durationMs / 1000);
      }
    }

    // Log the sandbox failure with its actual cause so a remote-agent failure
    // is diagnosable from the agent log alone (shipped to Loki for persistent
    // peers, dumped by the E2E run-id grep for ephemeral runs). For an
    // init-phase failure there are no step results, so result.error is the only
    // place the cause lives; for step failures we also list each failed step's
    // error message.
    if (result.status === ExecutionJobStatus.enum.failed) {
      const stepErrors = result.stepResults
        .filter((r) => r.error)
        .map((r) => `${r.name}: ${r.error!.message}`)
        .join(' | ');
      logger.error('Sandbox returned failed result', {
        durationMs: result.durationMs,
        stepCount: result.stepResults.length,
        steps: result.stepResults.map((r) => `${r.name}:${r.status}`).join(','),
        logStreamerKeys: [...logStreamers.keys()].join(','),
        ...(result.error && { error: result.error }),
        ...(stepErrors && { stepErrors }),
      });
    }

    // Step 6: Report final status from sandbox result
    this.sendJobStatus(
      dispatch,
      result.status,
      {
        durationMs: result.durationMs,
        ...(result.error && { error: result.error }),
        ...(result.outputs && { outputs: result.outputs }),
        // include dropped sibling job names for drift reporting
        ...(result.droppedJobs?.length && { droppedJobs: result.droppedJobs }),
        stepResults: result.stepResults.map((r) => ({
          name: r.name,
          status: r.status,
          durationMs: r.durationMs,
          ...(r.error && { error: r.error.message }),
        })),
      },
      result.secretOutputs,
    );
  }

  /**
   * Handle a build-only job.
   *
   * Build jobs install dependencies, pack them into a tarball,
   * and optionally compile the workflow bundle. They report
   * status back to the orchestrator but do not execute workflow steps.
   */
  private async handleBuildJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;

    // Print trace header once per build job (per locked decision)
    const buildCtx = getRequestContext();
    logger.info(`Run: ${buildCtx.runId ?? runId} | Trace: ${buildCtx.requestId ?? 'N/A'}`);

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    // Create a LogStreamer for the build step so logs appear in the dashboard.
    const buildStreamer = this.createStepStreamer(dispatch, 0);
    const buildLog = (msg: string) => buildStreamer.addLine(msg);

    // Report synthetic step as running so orchestrator creates execution_steps record
    this.sendStepStatus(dispatch, 0, 'build', ExecutionStepStatus.enum.running);

    // Emit job.context so the dashboard can show execution environment for build jobs
    this._sendJobContext(runId, jobId, {
      runtime: {
        nodeVersion: process.version,
        os: os.platform(),
        arch: os.arch(),
      },
      sandboxType: 'build',
      workingDirectory: workDir,
      gitRef: dispatch.ref,
      envVars: this.collectEnvVars({}),
    });

    // Start per-job heartbeat timer for stale run detection
    const heartbeatTimer = setInterval(() => {
      this.send({
        type: 'job.heartbeat',
        runId,
        jobId,
        timestamp: Date.now(),
      });
    }, this.config.jobHeartbeatIntervalMs);

    const buildConfig = jobConfig as unknown as BuildJobConfig;

    try {
      if (abortController.signal.aborted) {
        this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
        return;
      }

      await this.cloneAndApplyOverlay(dispatch, workDir, buildLog);

      const kiciDir = join(workDir, '.kici');

      await this.packAndUploadDeps(dispatch, kiciDir, buildConfig, buildLog);

      if (abortController.signal.aborted) {
        this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
        return;
      }

      await this.packAndUploadSource(dispatch, workDir, buildConfig, buildStreamer, buildLog);

      buildLog('Build completed successfully');
      buildStreamer.flush();
      buildStreamer.destroy();
      this.sendStepStatus(
        dispatch,
        0,
        'build',
        ExecutionStepStatus.enum.success,
        undefined,
        buildStreamer.getTotalBytes(),
      );
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success, {
        buildComplete: true,
        workflowName: buildConfig.workflowName,
      });
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      buildLog(`Build failed: ${errorMsg}`);
      buildStreamer.flush();
      buildStreamer.destroy();
      this.sendStepStatus(
        dispatch,
        0,
        'build',
        ExecutionStepStatus.enum.failed,
        {
          error: errorMsg,
        },
        buildStreamer.getTotalBytes(),
      );
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, {
        buildFailed: true,
        error: errorMsg,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  /**
   * Phase 1 of build: clone the source repo (with Prometheus timing) and apply
   * an overlay tarball if the dispatch carries one (test runs with
   * uncommitted changes).
   */
  private async cloneAndApplyOverlay(
    dispatch: JobDispatch,
    workDir: string,
    buildLog: (msg: string) => void,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;

    // 1. Clone repo (with Prometheus timing)
    buildLog(`Cloning ${dispatch.repoUrl} (ref: ${dispatch.ref})`);
    const cloneStart = Date.now();
    this.emitRunEvent(runId, 'agent.clone.start', { jobId });
    await gitClone({
      repoUrl: dispatch.repoUrl,
      ref: dispatch.ref,
      sha: dispatch.sha,
      workDir,
      gitAuth: dispatch.sourceAuth,
      token: dispatch.sourceAuth ? undefined : dispatch.token,
    });
    const cloneDurationMs = Date.now() - cloneStart;
    cloneDurationSeconds.record(cloneDurationMs / 1000);
    this.emitRunEvent(runId, 'agent.clone.end', { jobId, durationMs: cloneDurationMs });
    buildLog(`Clone completed in ${cloneDurationMs}ms`);

    // 1b. Apply overlay tarball if present (test runs with uncommitted changes)
    const tarballUrl = (jobConfig as Record<string, unknown>).tarballUrl as string | undefined;
    const cliPublicKey = (jobConfig as Record<string, unknown>).cliPublicKey as string | undefined;
    const orchestratorPrivateKey = (jobConfig as Record<string, unknown>).orchestratorPrivateKey as
      | string
      | undefined;

    if (tarballUrl && cliPublicKey && orchestratorPrivateKey) {
      logger.info('Applying overlay tarball for test run', { jobId });
      const overlayResult = await applyOverlay({
        tarballUrl,
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir: workDir,
      });
      logger.info('Overlay applied', {
        filesApplied: overlayResult.filesApplied,
        filesDeleted: overlayResult.filesDeleted,
      });
    }
  }

  /**
   * Phase 2 of build: install dependencies locally if needed for the build,
   * and (when the orchestrator has flagged the dep cache as stale) pack
   * `.kici/node_modules/` into a tarball and upload it to the deps cache.
   */
  private async packAndUploadDeps(
    dispatch: JobDispatch,
    kiciDir: string,
    buildConfig: BuildJobConfig,
    buildLog: (msg: string) => void,
  ): Promise<void> {
    // 2. Install deps if needed (bundle compilation also requires deps installed locally)
    const needDepsLocally = buildConfig.buildDepsNeeded || buildConfig.buildSourceNeeded;
    if (!needDepsLocally) return;

    const hasPackageJson = await fileExists(join(kiciDir, 'package.json'));
    if (!hasPackageJson) return;

    buildLog('Installing dependencies...');
    await installDeps(kiciDir, {
      npmRegistries: dispatch.npmRegistries,
      installEnvSecrets: dispatch.installEnvSecrets,
      jobIdShort: dispatch.jobId.slice(0, 8),
    });
    buildLog('Dependencies installed');

    // 3. Pack and upload dep tarball only when dep cache needs updating
    if (!buildConfig.buildDepsNeeded) return;

    const { tarball, hash } = await packNodeModules(kiciDir);

    const depKey = {
      lockfileHash: buildConfig.lockfileHash!,
      platform: os.platform(),
      arch: os.arch(),
    };
    logger.info('Requesting dep upload URL from orchestrator', {
      lockfileHash: buildConfig.lockfileHash,
    });
    const depUploadUrl = await this.requestUploadUrl(dispatch.jobId, 'deps', depKey);
    logger.info('Uploading dep tarball to S3', {
      size: tarball.length,
      hash: hash.slice(0, 12),
    });
    await uploadToPresignedUrl(depUploadUrl, tarball);
    this.sendUploadComplete(dispatch.jobId, 'deps', { ...depKey, depsHash: hash });
    logger.info('Dep tarball upload complete', {
      lockfileHash: buildConfig.lockfileHash,
    });
    buildLog(`Deps tarball uploaded (${tarball.length} bytes)`);

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running, {
      buildEvent: 'deps_packed',
      depsHash: hash,
      depsTarballSize: tarball.length,
    });
  }

  /**
   * Phase 3 of build: verify the cloned workflow source against the lock
   * file's expected `contentHash`, pack `.kici/` into a tarball, and upload
   * it to the source cache.
   */
  private async packAndUploadSource(
    dispatch: JobDispatch,
    workDir: string,
    buildConfig: BuildJobConfig,
    buildStreamer: LogStreamer,
    buildLog: (msg: string) => void,
  ): Promise<void> {
    // 4. Pack source tarball if needed
    if (!buildConfig.buildSourceNeeded || !buildConfig.contentHash) return;

    const sourceFile = (dispatch.jobConfig as { source?: { file: string } }).source?.file;
    if (!sourceFile) return;

    buildLog(`Verifying workflow source (${sourceFile})...`);
    // Verify the cloned source matches the lock file's expected contentHash
    // before packing — catches drift where the orchestrator saw a different
    // source revision than the agent cloned.
    //
    // Wrap in runCaptured so console.log / console.error at workflow module
    // top-level (imports with side effects, root-level diagnostics) land in
    // this build step's log.
    const buildSink: CaptureSink = { addLine: (line) => buildStreamer.addLine(line) };
    await runCaptured(buildSink, () =>
      loadWorkflowSource(
        workDir,
        sourceFile,
        buildConfig.contentHash,
        buildConfig.resolvedHashFiles,
      ),
    );

    buildLog('Packing .kici/ source tarball...');
    const { tarball, hash: sourceTarHash } = await packKiciSource(workDir);

    const sourceKey = {
      contentHash: buildConfig.contentHash,
      platform: os.platform(),
      arch: os.arch(),
    };
    logger.info('Requesting source tarball upload URL from orchestrator', {
      contentHash: buildConfig.contentHash,
    });
    const sourceUploadUrl = await this.requestUploadUrl(dispatch.jobId, 'source', sourceKey);
    logger.info('Uploading source tarball to S3', {
      size: tarball.length,
      contentHash: buildConfig.contentHash,
    });
    await uploadToPresignedUrl(sourceUploadUrl, tarball);
    this.sendUploadComplete(dispatch.jobId, 'source', sourceKey);
    logger.info('Source tarball upload complete', {
      contentHash: buildConfig.contentHash,
    });
    buildLog(
      `Source tarball packed and uploaded (${tarball.length} bytes, hash: ${buildConfig.contentHash.slice(0, 12)})`,
    );

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running, {
      buildEvent: 'source_packed',
      contentHash: buildConfig.contentHash,
      sourceTarHash,
    });
  }

  /**
   * Handle an init-only job.
   *
   * Init jobs evaluate dynamic functions (environment, env, concurrencyGroup)
   * from a compiled workflow bundle and report the resolved values back to the
   * orchestrator via job.status data payload. They do not execute workflow steps.
   *
   * A synthetic step 0 "init" LogStreamer carries console.log / structured log
   * output so operators get the same visibility into init jobs that they get
   * for regular steps. Module top-level code and each dynamic field function
   * run inside a runCaptured scope so their console.* writes land on this log.
   */
  private async handleInitJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;
    const config = jobConfig as {
      initOnly: true;
      targetJobName: string;
      workflowName: string;
      source: string;
      dynamicEnvironment: boolean;
      dynamicEnv: boolean;
      dynamicConcurrencyGroup: boolean;
      dynamicMatrix?: boolean;
      event: Record<string, unknown>;
      timeoutMs?: number;
      contentHash?: string;
      resolvedHashFiles?: string[];
    };

    logger.info('Starting init job', {
      jobId,
      targetJobName: config.targetJobName,
      workflowName: config.workflowName,
    });

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    // Create a LogStreamer for the synthetic "init" step so user output during
    // dynamic-field evaluation appears in the dashboard.
    const initStreamer = this.createStepStreamer(dispatch, 0);
    const initLog = (msg: string) => initStreamer.addLine(msg);
    const initSink: CaptureSink = { addLine: (line) => initStreamer.addLine(line) };

    this.sendStepStatus(dispatch, 0, 'init', ExecutionStepStatus.enum.running);

    // Start heartbeat for stale detection
    const heartbeatTimer = setInterval(() => {
      this.send({
        type: 'job.heartbeat',
        runId,
        jobId,
        timestamp: Date.now(),
      });
    }, this.config.jobHeartbeatIntervalMs);

    try {
      if (abortController.signal.aborted) {
        await initStreamer.flush();
        initStreamer.destroy();
        this.sendStepStatus(
          dispatch,
          0,
          'init',
          ExecutionStepStatus.enum.skipped,
          undefined,
          initStreamer.getTotalBytes(),
        );
        this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
        return;
      }

      // 1. Restore deps (needed for workflow imports like @kici-dev/sdk)
      if (dispatch.depsUrl) {
        initLog('Restoring dependencies from cache');
        await restoreDeps(workDir, dispatch.depsUrl, dispatch.depsHash);
      }

      // 2. Materialize workflow source: extract from cached tarball if present,
      //    otherwise clone from the source repo.
      if (dispatch.sourceTarUrl) {
        initLog('Restoring workflow source from cached tarball');
        await restoreSource(workDir, dispatch.sourceTarUrl);
      } else {
        initLog(`Cloning ${dispatch.repoUrl} (ref: ${dispatch.ref})`);
        const cloneStart = Date.now();
        await gitClone({
          repoUrl: dispatch.repoUrl,
          ref: dispatch.ref,
          sha: dispatch.sha,
          workDir,
          gitAuth: dispatch.sourceAuth,
          token: dispatch.sourceAuth ? undefined : dispatch.token,
        });
        cloneDurationSeconds.record((Date.now() - cloneStart) / 1000);
      }

      // 3. Install deps locally if the cached tarball wasn't provided —
      //    @kici-dev/sdk must resolve under .kici/node_modules/ at import time.
      const kiciDir = join(workDir, '.kici');
      const hasPackage = await fileExists(join(kiciDir, 'package.json'));
      logger.info('Init job: checking deps', {
        kiciDir,
        hasPackageJson: hasPackage,
        source: config.source,
      });
      if (!dispatch.depsUrl && hasPackage) {
        initLog('Installing dependencies locally');
        await installDeps(kiciDir, {
          npmRegistries: dispatch.npmRegistries,
          installEnvSecrets: dispatch.installEnvSecrets,
          jobIdShort: dispatch.jobId.slice(0, 8),
        });
      }

      // Wrap module load + dynamic-field evaluation in a console-capture scope.
      // Any console.log in the workflow module top-level or inside a dynamic
      // environment / env / concurrencyGroup function lands on this init log.
      const initResult = await runCaptured(initSink, async () => {
        const { module } = await loadWorkflowSource(
          workDir,
          config.source,
          config.contentHash,
          config.resolvedHashFiles,
        );
        const workflow = extractWorkflow(module, config.workflowName);
        initLog(
          `Evaluating dynamic fields for job '${config.targetJobName}' (env=${config.dynamicEnv} environment=${config.dynamicEnvironment} concurrencyGroup=${config.dynamicConcurrencyGroup} matrix=${config.dynamicMatrix ?? false})`,
        );
        return evaluateDynamicFields(
          workflow,
          config.targetJobName,
          config.event,
          {
            dynamicEnvironment: config.dynamicEnvironment,
            dynamicEnv: config.dynamicEnv,
            dynamicConcurrencyGroup: config.dynamicConcurrencyGroup,
            dynamicMatrix: config.dynamicMatrix ?? false,
          },
          config.timeoutMs,
        );
      });

      logger.info('Init job completed successfully', {
        jobId,
        hasEnvironment: initResult.environmentName !== undefined,
        hasEnv: initResult.env !== undefined,
        hasConcurrencyGroup: initResult.concurrencyGroup !== undefined,
      });

      initLog('Init completed successfully');
      await initStreamer.flush();
      initStreamer.destroy();
      this.sendStepStatus(
        dispatch,
        0,
        'init',
        ExecutionStepStatus.enum.success,
        undefined,
        initStreamer.getTotalBytes(),
      );

      // 3. Report success with init results
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success, {
        initResult,
        initComplete: true,
      });
    } catch (err) {
      // if dynamic function throws, job fails immediately
      const errorMsg = toErrorMessage(err);
      logger.error('Init job failed', { jobId, error: errorMsg });
      initLog(`Error: ${errorMsg}`);
      await initStreamer.flush();
      initStreamer.destroy();
      this.sendStepStatus(
        dispatch,
        0,
        'init',
        ExecutionStepStatus.enum.failed,
        {
          error: errorMsg,
        },
        initStreamer.getTotalBytes(),
      );
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, {
        error: errorMsg,
        initFailed: true,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  /**
   * Handle DynamicJobFn evaluation jobs.
   *
   * Loads the workflow bundle, extracts the DynamicJobFn by index, calls it
   * with a DynamicJobContext, serializes the returned Job[] to LockJob[],
   * and sends the result back to the orchestrator.
   */
  private async handleDynamicJobFn(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;
    const config = jobConfig as {
      dynamicJobFn: true;
      workflowName: string;
      source: { file: string; index: number };
      event: Record<string, unknown>;
      timeoutMs?: number;
      contentHash?: string;
      resolvedHashFiles?: string[];
      /** Result-aware generator: declared needs + the frozen upstream snapshot. */
      resultAware?: boolean;
      declaredNeeds?: readonly unknown[];
      upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot;
    };

    const timeoutMs = config.timeoutMs ?? 120_000;

    logger.info('Starting DynamicJobFn evaluation', {
      jobId,
      workflowName: config.workflowName,
      sourceIndex: config.source.index,
    });

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    // Create LogStreamer for the "evaluate" step so logs appear in the dashboard.
    const evalStreamer = this.createStepStreamer(dispatch, 0);
    const evalLog = (msg: string) => evalStreamer.addLine(msg);

    this.sendStepStatus(dispatch, 0, 'evaluate', ExecutionStepStatus.enum.running);

    // Start heartbeat for stale detection
    const heartbeatTimer = setInterval(() => {
      this.send({
        type: 'job.heartbeat',
        runId,
        jobId,
        timestamp: Date.now(),
      });
    }, this.config.jobHeartbeatIntervalMs);

    try {
      if (abortController.signal.aborted) {
        this.sendStepStatus(
          dispatch,
          0,
          'evaluate',
          ExecutionStepStatus.enum.skipped,
          undefined,
          evalStreamer.getTotalBytes(),
        );
        this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
        return;
      }

      // 1. Restore deps (needed for workflow imports like @kici-dev/sdk)
      if (dispatch.depsUrl) {
        evalLog('Restoring dependencies from cache');
        await restoreDeps(workDir, dispatch.depsUrl, dispatch.depsHash);
        evalLog('Dependencies restored');
      }

      // 2. Materialize workflow source: extract from cached tarball if present,
      //    otherwise clone from the source repo.
      if (dispatch.sourceTarUrl) {
        evalLog('Restoring workflow source from cached tarball');
        await restoreSource(workDir, dispatch.sourceTarUrl);
      } else {
        evalLog(`Cloning ${dispatch.repoUrl} ref=${dispatch.ref}`);
        const cloneStart = Date.now();
        await gitClone({
          repoUrl: dispatch.repoUrl,
          ref: dispatch.ref,
          sha: dispatch.sha,
          workDir,
          gitAuth: dispatch.sourceAuth,
          token: dispatch.sourceAuth ? undefined : dispatch.token,
        });
        cloneDurationSeconds.record((Date.now() - cloneStart) / 1000);
      }

      // 3. Install deps locally if the cached tarball wasn't provided —
      //    @kici-dev/sdk must resolve under .kici/node_modules/ at import time.
      const kiciDir = join(workDir, '.kici');
      if (!dispatch.depsUrl && (await fileExists(join(kiciDir, 'package.json')))) {
        evalLog('Installing dependencies locally');
        await installDeps(kiciDir, {
          npmRegistries: dispatch.npmRegistries,
          installEnvSecrets: dispatch.installEnvSecrets,
          jobIdShort: dispatch.jobId.slice(0, 8),
        });
      }

      // 3. Build a per-invocation zx `$` whose subprocess stdout / stderr flows
      //    into the eval streamer. Mirrors the sandbox's $.log callback wiring in
      //    workflow-runner.ts:createSandboxStepContext. Without this, `await $`...``
      //    calls inside the DynamicJobFn body or inside matrix fns would be
      //    invisible (zx pipes child stdio to an internal VoidStream and only
      //    surfaces it through the log callback).
      const { $: zx$ } = await import('zx');
      let zxLineBuf = '';
      const scopedDollar = zx$({
        cwd: workDir,
        env: { ...process.env } as Record<string, string>,
        verbose: false,
        quiet: false,
        log: ((entry: { kind: string; data: unknown }) => {
          if (entry.kind !== 'stdout' && entry.kind !== 'stderr') return;
          const text = typeof entry.data === 'string' ? entry.data : String(entry.data ?? '');
          zxLineBuf += text;
          const lines = zxLineBuf.split('\n');
          zxLineBuf = lines.pop()!;
          for (const line of lines) {
            if (line) evalStreamer.addLine(line);
          }
        }) as unknown as (entry: unknown) => void,
      }) as unknown as typeof zx$;

      const evalSink: CaptureSink = { addLine: (line) => evalStreamer.addLine(line) };

      // Route DynamicJobFn log calls through evalLog so they appear in the dashboard.
      // This is redundant with console.* capture below (both land in the same
      // streamer) and intentional — users can pick whichever style suits them.
      const dynamicJobLogger = {
        info: (msg: string, ..._args: unknown[]) => evalLog(msg),
        warn: (msg: string, ..._args: unknown[]) => evalLog(`WARN: ${msg}`),
        error: (msg: string, ..._args: unknown[]) => evalLog(`ERROR: ${msg}`),
        debug: (msg: string, ..._args: unknown[]) => evalLog(`DEBUG: ${msg}`),
      };
      const kici = buildKiciApi(
        this._sendApiRequest
          ? (method, params) => this._sendApiRequest!(method, params ?? {})
          : () => Promise.reject(new Error('Agent API not available')),
      );

      // 4. Wrap module load, DynamicJobFn invocation, and generated-job serialization
      //    under a single console-capture scope. Module top-level `console.log`,
      //    `console.log` inside the DynamicJobFn body, and `console.log` inside
      //    per-generated-job env/environment/concurrencyGroup/matrix fns all land
      //    on the eval step's log.
      const lockJobs = await runCaptured(evalSink, async () => {
        const { module } = await loadWorkflowSource(
          workDir,
          config.source.file,
          config.contentHash,
          config.resolvedHashFiles,
        );
        evalLog('Workflow loaded');

        const { extractDynamicJobFn } = await import('./workflow-loader.js');
        const workflow = extractWorkflow(module, config.workflowName);
        const dynamicFn = extractDynamicJobFn(workflow, config.source.index);

        evalLog(`Evaluating DynamicJobFn (index ${config.source.index}, timeout ${timeoutMs}ms)`);

        // Result-aware generators see their declared upstreams' frozen outputs
        // as ctx.needs, built from the snapshot the orchestrator captured at eval
        // dispatch (never a live read — see the determinism contract).
        const needs = buildEvalNeedsContext(config);

        const context = {
          $: scopedDollar,
          ctx: {
            workflow: { name: config.workflowName },
            // Boundary cast: the wire `config.event` is untyped JSON that, per
            // the unified event protocol, always carries the normalized event
            // envelope. This is where it enters the DynamicJobFn's user context.
            event: config.event as EventPayload,
            ...(needs && { needs }),
          },
          log: dynamicJobLogger,
          env: process.env as Record<string, string | undefined>,
          kici,
        };

        const generatedJobs = await withTimeout(
          () => dynamicFn(context),
          timeoutMs,
          `DynamicJobFn index ${config.source.index} in workflow '${config.workflowName}'`,
        );

        // 5. Serialize to LockJob[] format. Dynamic env/environment/concurrencyGroup/matrix
        // functions on generated jobs are resolved here against the same eval context that
        // was just passed to the parent DynamicJobFn. The frozen upstream snapshot rides
        // along so each generated job's dynamicSource carries it for deterministic re-eval.
        return serializeJobsToLock(generatedJobs, {
          event: config.event,
          $: scopedDollar,
          log: dynamicJobLogger,
          env: process.env as Record<string, string | undefined>,
          workflowName: config.workflowName,
        });
      });

      logger.info('DynamicJobFn evaluation completed', {
        jobId,
        generatedJobCount: lockJobs.length,
        jobNames: lockJobs.map((j) => j.name),
      });

      evalLog(`Generated ${lockJobs.length} job(s): ${lockJobs.map((j) => j.name).join(', ')}`);

      // 6. Report success with generated jobs
      await evalStreamer.flush();
      evalStreamer.destroy();
      this.sendStepStatus(
        dispatch,
        0,
        'evaluate',
        ExecutionStepStatus.enum.success,
        undefined,
        evalStreamer.getTotalBytes(),
      );
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success, {
        dynamicJobs: lockJobs,
        dynamicComplete: true,
      });
    } catch (err) {
      const errorMsg = toErrorMessage(err);
      logger.error('DynamicJobFn evaluation failed', { jobId, error: errorMsg });
      evalLog(`Error: ${errorMsg}`);
      await evalStreamer.flush();
      evalStreamer.destroy();
      this.sendStepStatus(
        dispatch,
        0,
        'evaluate',
        ExecutionStepStatus.enum.failed,
        {
          error: errorMsg,
        },
        evalStreamer.getTotalBytes(),
      );
      const dynamicData: Record<string, unknown> = { error: errorMsg, dynamicFailed: true };
      if (err instanceof MatrixExpansionError) {
        dynamicData.initFailure = {
          scope: 'job',
          category: InitFailureCategory.enum.matrix_expansion,
          message: errorMsg,
          jobName: err.jobName,
        };
      }
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, dynamicData);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  /**
   * Create the appropriate sandbox backend based on execution mode.
   */
  private createSandbox(
    mode: ExecutionMode,
    opts: {
      runnerPath: string;
      env: Record<string, string>;
      jobId: string;
      jobConfig: Record<string, unknown>;
    },
  ): ExecutionSandbox {
    switch (mode) {
      case 'container': {
        const containerConfig = opts.jobConfig.container;
        const image =
          typeof containerConfig === 'string'
            ? containerConfig
            : ((containerConfig as { image: string })?.image ?? 'node:20-alpine');

        return new ContainerSandbox({
          docker: new Docker(),
          image,
          runnerPath: opts.runnerPath,
          env: opts.env,
          keepFailed: this.config.dockerKeepFailed,
          jobId: opts.jobId,
        });
      }

      case 'firecracker':
        return new FirecrackerSandbox({
          runnerPath: opts.runnerPath,
          env: opts.env,
        });

      case 'bare-metal':
      default:
        return new BareMetalSandbox({
          runnerPath: opts.runnerPath,
          env: opts.env,
          sandbox: this.config.sandbox,
          sandboxNetwork: this.config.sandboxNetwork,
        });
    }
  }

  /**
   * Collect relevant environment variables for the job.context message.
   *
   * Returns KICI_* system vars (visible) and user-defined workflow vars.
   * Secret values are masked as '***'. Full process.env is NOT sent
   * to avoid leaking host configuration.
   */
  private collectEnvVars(
    sanitizedEnv: Record<string, string>,
  ): Array<{ name: string; value: string; category: 'system' | 'user' | 'inherited' | 'secret' }> {
    const vars: Array<{
      name: string;
      value: string;
      category: 'system' | 'user' | 'inherited' | 'secret';
    }> = [];

    // Collect KICI_* system vars from process.env
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('KICI_') && value !== undefined) {
        vars.push({ name: key, value, category: 'system' });
      }
    }

    // Collect user-defined env vars from sanitizedEnv (workflow-configured)
    for (const [key, value] of Object.entries(sanitizedEnv)) {
      if (!key.startsWith('KICI_')) {
        vars.push({ name: key, value, category: 'user' });
      }
    }

    return vars;
  }

  /**
   * Emit a run.event message to the orchestrator for infrastructure lifecycle tracking.
   */
  private emitRunEvent(
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ): void {
    this._sendRunEvent(runId, eventType, opts);
  }

  /**
   * Emit a `cache.restore` / `cache.save` run event for a cache pseudo-step.
   *
   * The cache phase tags its `step.complete` IPC with a {@link CacheStepType}
   * `step_type` and a `data.cacheOutcome` ({@link CacheOutcome}); when one of
   * those terminal pseudo-step statuses arrives here, mirror it onto the run
   * timeline as a `run.event` so hit/miss/saved/skipped/error is recorded for
   * the dashboard. A no-op for regular steps and hooks.
   */
  private maybeEmitCacheRunEvent(
    runId: string,
    jobId: string,
    stepIndex: number,
    state: string,
    data?: Record<string, unknown>,
  ): void {
    if (state === ExecutionStepStatus.enum.running) return;
    const stepType = data?.step_type;
    const eventType =
      stepType === CacheStepType.enum['cache:restore']
        ? CacheRunEventType.enum['cache.restore']
        : stepType === CacheStepType.enum['cache:save']
          ? CacheRunEventType.enum['cache.save']
          : undefined;
    if (!eventType) return;
    this.emitRunEvent(runId, eventType, {
      jobId,
      metadata: {
        stepIndex,
        ...(data?.cacheOutcome !== undefined && { outcome: data.cacheOutcome }),
        ...(data?.key !== undefined && { key: data.key }),
        ...(data?.matchedKey !== undefined && { matchedKey: data.matchedKey }),
        ...(data?.bytes !== undefined && { bytes: data.bytes }),
      },
    });
  }

  /**
   * Create a LogStreamer for a synthetic step (build, evaluate, etc.).
   */
  private createStepStreamer(dispatch: JobDispatch, stepIndex: number): LogStreamer {
    return new LogStreamer({
      send: (msg) => this.send(msg),
      runId: dispatch.runId,
      jobId: dispatch.jobId,
      stepIndex,
      maxLogSizeBytes: dispatch.maxLogSizeBytes ?? this.config.maxLogSizeBytes,
      getBufferedAmount: this.getBufferedAmount,
      backpressureMode: this.config.backpressureMode,
      onWsDrain: this.onDrain,
    });
  }

  /**
   * Send a job.status message to the orchestrator.
   *
   * When secretOutputs are provided (encrypted envelopes from the sandbox),
   * they are included as a top-level field on the WS message (not nested in data).
   */
  private sendJobStatus(
    dispatch: JobDispatch,
    state: JobStatus['state'],
    data?: Record<string, unknown>,
    secretOutputs?: Record<string, { agentPublicKey: string; encrypted: string }>,
  ): void {
    this.sendDirect({
      type: 'job.status',
      messageId: randomUUID(),
      runId: dispatch.runId,
      jobId: dispatch.jobId,
      state,
      timestamp: Date.now(),
      ...(data && { data }),
      ...(secretOutputs && { secretOutputs }),
    });
  }

  /**
   * Send a step.status message to the orchestrator.
   *
   * @param logBytesStreamed total raw stream bytes accumulated by this step's
   *   LogStreamer. Set on terminal step states so the orchestrator can
   *   accumulate per-job and per-run totals for the operator-side
   *   `kici_org_log_bytes` capacity-planning gauge. Undefined for the
   *   `running` transition.
   */
  private sendStepStatus(
    dispatch: JobDispatch,
    stepIndex: number,
    stepName: string,
    state: string,
    data?: Record<string, unknown>,
    logBytesStreamed?: number,
  ): void {
    // Extract secretsAccessed from data to send as top-level field (per protocol schema)
    const secretsAccessed = data?.secretsAccessed as string[] | undefined;
    const { secretsAccessed: _, ...restData } = data ?? {};
    const hasRestData = Object.keys(restData).length > 0;

    this.sendDirect({
      type: 'step.status',
      messageId: randomUUID(),
      runId: dispatch.runId,
      jobId: dispatch.jobId,
      stepIndex,
      stepName,
      state: state as AgentStepStatus['state'],
      timestamp: Date.now(),
      ...(hasRestData && { data: restData }),
      ...(secretsAccessed !== undefined && { secretsAccessed }),
      ...(logBytesStreamed !== undefined && { logBytesStreamed }),
    });
  }
}
