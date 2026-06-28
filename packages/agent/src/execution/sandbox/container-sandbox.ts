/**
 * Container execution sandbox implementation.
 *
 * The strongest isolation model: the agent runs on the host while the entire
 * job lifecycle (clone, dependency install, compile, step execution) runs
 * inside a disposable Docker/Podman container. Communication uses stdin/stdout
 * JSON-lines via dockerode's exec API.
 *
 * Key properties:
 * - Container stays alive for the entire job (sleep infinity)
 * - Workflow runner is bind-mounted read-only into the container
 * - Agent-internal credentials (KICI_*, KICI_DATABASE_URL, etc.) NEVER enter the container
 * - IPC uses demuxed Docker stream with JSON-line parsing on stdout
 *
 * The container image MUST have Node.js installed (a kici/runner base image
 * is deferred -- for now this is a documented requirement).
 */

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import Docker from 'dockerode';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionJobStatus, ExecutionStepStatus } from '@kici-dev/engine';
import type {
  ExecutionSandbox,
  SandboxSetupOptions,
  JobExecutionOptions,
  JobExecutionResult,
  SandboxStepResult,
} from './types.js';
import type {
  RunnerToAgentMessage,
  AgentToRunnerMessage,
  EventEmitRequest,
  ConcurrencyReportMessage,
  AgentApiRequestIpc,
  CacheRequestIpc,
  ProvenanceRequestIpc,
  StepApprovalRequestIpc,
} from './ipc-protocol.js';
import { buildRequest } from './fork-runner.js';
import { encryptSecretOutputs } from './secret-encryption.js';

const logger = createLogger({ prefix: 'container-sandbox' });

/** Maximum lines of stderr to keep for crash diagnostics. */
const MAX_STDERR_LINES = 20;

/** Grace period (ms) to wait for graceful abort before killing. */
const ABORT_GRACE_MS = 10_000;

/** Stop timeout (seconds) for container stop. */
const CONTAINER_STOP_TIMEOUT = 10;

// --- Options ---

interface ContainerSandboxOptions {
  /** Dockerode instance (from orchestrator/scaler or created locally). */
  docker: Docker;
  /** Container image to use (from job config or scaler label-set). */
  image: string;
  /** Path to workflow-runner.js on the HOST (will be bind-mounted). */
  runnerPath: string;
  /** Mount target inside container (default: /opt/kici/workflow-runner.js). */
  runnerMountPath?: string;
  /** Pre-sanitized environment variables for the container. */
  env: Record<string, string>;
  /** Whether to keep failed containers for debugging. */
  keepFailed?: boolean;
  /** Job ID for container labeling and orphan cleanup. */
  jobId?: string;
}

// --- Internal helper types ---

/**
 * Stream context returned by attachExecStream — bundles the bidirectional
 * exec stream, the demuxed stdout passthrough, the rolling stderr buffer,
 * the stderr readline (so the caller can close it), and the abort handler
 * (so the caller can detach it on cleanup).
 */
interface ExecStreamContext {
  stream: NodeJS.ReadWriteStream;
  stdout: PassThrough;
  stderrLines: string[];
  stderrRl: ReturnType<typeof createInterface>;
  abortHandler: () => void;
}

/**
 * Mutable state threaded through the readline message dispatcher. Mutated by
 * dispatchRunnerMessage so `awaitJobCompletion` can resolve with a snapshot.
 */
interface MutableRunnerState {
  jobStatus: 'success' | 'failed' | 'cancelled';
  jobOutputs: Record<string, Record<string, unknown>> | undefined;
  encryptedSecretOutputs: Record<string, { agentPublicKey: string; encrypted: string }> | undefined;
}

/**
 * Snapshot returned by awaitJobCompletion — the per-promise final state of
 * the runner just before the abort-signal short-circuit fires.
 */
interface RunnerOutcome {
  jobStatus: 'success' | 'failed' | 'cancelled';
  stepResults: SandboxStepResult[];
  jobOutputs: Record<string, Record<string, unknown>> | undefined;
  encryptedSecretOutputs: Record<string, { agentPublicKey: string; encrypted: string }> | undefined;
}

/**
 * Relay event.emit from the container runner to the orchestrator via
 * options.onEventEmit, then write the response back through `stream`.
 * Errors land as a structured error response (not a thrown rejection).
 */
function relayEventEmit(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  emitMsg: EventEmitRequest,
): void {
  options.onEventEmit(emitMsg).then(
    (response) => {
      try {
        stream.write(JSON.stringify(response) + '\n');
      } catch {
        // Stream may be closed
      }
    },
    (err) => {
      try {
        stream.write(
          JSON.stringify({
            type: 'event.emit.response',
            requestId: emitMsg.requestId,
            error: toErrorMessage(err),
          }) + '\n',
        );
      } catch {
        // Stream may be closed
      }
    },
  );
}

/**
 * Relay concurrency.report from the container runner to the orchestrator,
 * then write the ack back through `stream`. On error, returns a synthetic
 * `cancel` ack carrying the error message.
 */
function relayConcurrencyReport(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  reportMsg: ConcurrencyReportMessage,
): void {
  options.onConcurrencyReport(reportMsg).then(
    (ack) => {
      try {
        stream.write(JSON.stringify(ack) + '\n');
      } catch {
        // Stream may be closed
      }
    },
    (err) => {
      try {
        stream.write(
          JSON.stringify({
            type: 'concurrency.ack',
            action: 'cancel' as const,
            reason: toErrorMessage(err),
          }) + '\n',
        );
      } catch {
        // Stream may be closed
      }
    },
  );
}

/**
 * Relay agent.api.request from the container runner to the orchestrator
 * via options.onApiRequest. If the agent doesn't expose an API relay,
 * write a structured error response so the runner doesn't hang.
 */
function relayApiRequest(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  apiMsg: AgentApiRequestIpc,
): void {
  if (options.onApiRequest) {
    options.onApiRequest(apiMsg.method, apiMsg.params).then(
      (result) => {
        try {
          stream.write(
            JSON.stringify({
              type: 'agent.api.response',
              requestId: apiMsg.requestId,
              result,
            }) + '\n',
          );
        } catch {
          // Stream may be closed
        }
      },
      (err) => {
        try {
          stream.write(
            JSON.stringify({
              type: 'agent.api.response',
              requestId: apiMsg.requestId,
              error: toErrorMessage(err),
            }) + '\n',
          );
        } catch {
          // Stream may be closed
        }
      },
    );
  } else {
    try {
      stream.write(
        JSON.stringify({
          type: 'agent.api.response',
          requestId: apiMsg.requestId,
          error: 'Agent API not available in this agent configuration',
        }) + '\n',
      );
    } catch {
      // Stream may be closed
    }
  }
}

/**
 * Relay cache.request from the container runner to the orchestrator via
 * options.onCacheRequest, then write the response back through `stream`. If
 * the agent doesn't expose a cache relay, write a structured error response
 * so the runner doesn't hang.
 */
function relayCacheRequest(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  cacheMsg: CacheRequestIpc,
): void {
  const writeResponse = (response: Record<string, unknown>): void => {
    try {
      stream.write(JSON.stringify(response) + '\n');
    } catch {
      // Stream may be closed
    }
  };
  if (!options.onCacheRequest) {
    writeResponse({
      type: 'cache.response',
      requestId: cacheMsg.requestId,
      error: 'Cache not available in this agent configuration',
    });
    return;
  }
  options.onCacheRequest(cacheMsg).then(
    (response) => writeResponse(response as unknown as Record<string, unknown>),
    (err) =>
      writeResponse({
        type: 'cache.response',
        requestId: cacheMsg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/**
 * Relay provenance.request from the container runner to the orchestrator via
 * options.onProvenanceRequest, then write the response back through `stream`.
 * If the agent doesn't expose a provenance relay, write a structured error so
 * the runner doesn't hang.
 */
function relayProvenanceRequest(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  provMsg: ProvenanceRequestIpc,
): void {
  const writeResponse = (response: Record<string, unknown>): void => {
    try {
      stream.write(JSON.stringify(response) + '\n');
    } catch {
      // Stream may be closed
    }
  };
  if (!options.onProvenanceRequest) {
    writeResponse({
      type: 'provenance.response',
      requestId: provMsg.requestId,
      error: 'Provenance not available in this agent configuration',
    });
    return;
  }
  options.onProvenanceRequest(provMsg).then(
    (response) => writeResponse(response as unknown as Record<string, unknown>),
    (err) =>
      writeResponse({
        type: 'provenance.response',
        requestId: provMsg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/**
 * Relay approval.request from the container runner to the orchestrator via
 * options.onApprovalRequest, then write the resolution back through `stream`.
 * If the agent doesn't expose an approval relay (or it throws), write a
 * fail-closed reject so the runner doesn't hang.
 */
function relayApprovalRequest(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  approvalMsg: StepApprovalRequestIpc,
): void {
  const writeResponse = (response: Record<string, unknown>): void => {
    try {
      stream.write(JSON.stringify(response) + '\n');
    } catch {
      // Stream may be closed
    }
  };
  if (!options.onApprovalRequest) {
    writeResponse({
      type: 'approval.resolved',
      requestId: approvalMsg.requestId,
      error: 'Approvals not available in this agent configuration',
    });
    return;
  }
  options.onApprovalRequest(approvalMsg).then(
    (response) => writeResponse(response as unknown as Record<string, unknown>),
    (err) =>
      writeResponse({
        type: 'approval.resolved',
        requestId: approvalMsg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/**
 * Apply a job.complete message to the mutable runner state: capture status,
 * merge any bulk-reported step results, propagate plain outputs, and encrypt
 * secret outputs if a run public key is available.
 */
function applyJobComplete(
  msg: Extract<RunnerToAgentMessage, { type: 'job.complete' }>,
  stepResults: SandboxStepResult[],
  state: MutableRunnerState,
  options: JobExecutionOptions,
): void {
  state.jobStatus = msg.status;

  // Merge any step results we didn't already see via step.complete
  // (e.g. skipped steps reported in bulk).
  if (msg.stepResults && msg.stepResults.length > stepResults.length) {
    // Replace with the runner's authoritative list.
    stepResults.length = 0;
    stepResults.push(...msg.stepResults);
  }

  // Capture plain outputs for cross-job transport
  if (msg.outputs) {
    state.jobOutputs = msg.outputs;
  }

  // Encrypt secret outputs if present and run has a public key
  if (msg.secretOutputs && options.dispatch.runPublicKey) {
    try {
      state.encryptedSecretOutputs = encryptSecretOutputs(
        msg.secretOutputs,
        options.dispatch.runPublicKey,
      );
    } catch (err) {
      logger.warn('Failed to encrypt secret outputs', {
        error: toErrorMessage(err),
      });
    }
  }
}

// --- Implementation ---

export class ContainerSandbox implements ExecutionSandbox {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly runnerPath: string;
  private readonly runnerMountPath: string;
  private readonly env: Record<string, string>;
  private readonly keepFailed: boolean;
  private readonly jobId: string;

  /** The running container instance (set during setup). */
  private container: Docker.Container | null = null;
  /** The active exec stream (set during executeJob, used for abort). */
  private execStream: NodeJS.ReadWriteStream | null = null;
  /** Whether the job failed (used in teardown for keepFailed). */
  private jobFailed = false;
  /** Container name for logging/debugging. */
  private containerName = '';

  constructor(options: ContainerSandboxOptions) {
    this.docker = options.docker;
    this.image = options.image;
    this.runnerPath = options.runnerPath;
    this.runnerMountPath = options.runnerMountPath ?? '/opt/kici/workflow-runner.js';
    this.env = options.env;
    this.keepFailed = options.keepFailed ?? false;
    this.jobId = options.jobId ?? `unknown-${Date.now()}`;
  }

  // --- Lifecycle: setup ---

  async setup(options: SandboxSetupOptions): Promise<void> {
    this.containerName = `kici-sandbox-${this.jobId}-${Date.now()}`;

    // Build env array (key=value format) from sanitized env.
    // This env has already been processed by buildSanitizedEnv() -- NO agent credentials.
    const envArray = Object.entries(this.env).map(([k, v]) => `${k}=${v}`);

    logger.info('Creating sandbox container', {
      name: this.containerName,
      image: this.image,
      workDir: options.workDir,
    });

    // Create container:
    // - sleep infinity keeps it alive for the entire job
    // - Work directory bind-mounted read-write at /workspace
    // - Workflow runner bind-mounted read-only
    this.container = await this.docker.createContainer({
      Image: this.image,
      name: this.containerName,
      Cmd: ['sleep', 'infinity'],
      Env: envArray,
      WorkingDir: '/workspace',
      Labels: {
        'kici-sandbox': 'true',
        'kici-job-id': this.jobId,
      },
      HostConfig: {
        Binds: [`${options.workDir}:/workspace`, `${this.runnerPath}:${this.runnerMountPath}:ro`],
      },
    });

    await this.container.start();

    logger.info('Sandbox container started', {
      name: this.containerName,
      containerId: this.container.id.slice(0, 12),
    });
  }

  // --- Lifecycle: executeJob ---

  async executeJob(options: JobExecutionOptions): Promise<JobExecutionResult> {
    if (!this.container) {
      throw new Error('ContainerSandbox.executeJob() called before setup()');
    }

    const startTime = Date.now();

    // Phase 1: Create exec, start the bidirectional stream, demux Docker
    // multiplexed stream, capture stderr for crash diagnostics, and install
    // the abort signal listener.
    const streamCtx = await this.attachExecStream(options);

    // Phase 2: Drive the readline message loop until job.complete (or crash).
    let outcome: RunnerOutcome;
    try {
      outcome = await this.awaitJobCompletion(streamCtx, options);
    } catch (err) {
      logger.error('Job execution error', {
        error: toErrorMessage(err),
        stderrTail: streamCtx.stderrLines.slice(-5).join('\n'),
      });
      outcome = {
        jobStatus: ExecutionJobStatus.enum.failed,
        stepResults: [],
        jobOutputs: undefined,
        encryptedSecretOutputs: undefined,
      };
    } finally {
      options.signal.removeEventListener('abort', streamCtx.abortHandler);
      streamCtx.stderrRl.close();
      this.execStream = null;
    }

    // Phase 3: Apply abort-signal short-circuit, finalize jobFailed flag, and
    // build the JobExecutionResult.
    return this.buildExecutionResult(outcome, options, startTime);
  }

  /**
   * Phase 1 of executeJob: create the docker exec, start it in hijack mode,
   * demux the multiplexed stream into stdout / stderr passthroughs, capture
   * stderr lines for crash diagnostics, and install the abort listener.
   */
  private async attachExecStream(options: JobExecutionOptions): Promise<ExecStreamContext> {
    // Build the exec environment -- same sanitized env, no agent credentials.
    const execEnv = Object.entries(this.env).map(([k, v]) => `${k}=${v}`);

    // Create exec inside the running container.
    const exec = await this.container!.exec({
      Cmd: ['node', this.runnerMountPath],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: execEnv,
      WorkingDir: '/workspace',
    });

    // Start exec with hijack mode for bidirectional stdin/stdout.
    const stream = await exec.start({ hijack: true, stdin: true });
    this.execStream = stream;

    // Demux the Docker multiplexed stream.
    // Docker multiplexes stdout and stderr into a single stream with 8-byte headers.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    // Capture stderr for crash diagnostics (last N lines).
    const stderrLines: string[] = [];
    const stderrRl = createInterface({ input: stderr, crlfDelay: Infinity });
    stderrRl.on('line', (line) => {
      stderrLines.push(line);
      if (stderrLines.length > MAX_STDERR_LINES) {
        stderrLines.shift();
      }
    });

    // Set up abort signal listener.
    const abortHandler = () => {
      this.handleAbort().catch((err) => {
        logger.warn('Error during abort', {
          error: toErrorMessage(err),
        });
      });
    };
    options.signal.addEventListener('abort', abortHandler, { once: true });

    return { stream, stdout, stderrLines, stderrRl, abortHandler };
  }

  /**
   * Phase 2 of executeJob: drive the readline IPC loop until job.complete,
   * exec exit, or crash. Returns the final job status, accumulated step
   * results, and any captured outputs.
   */
  private awaitJobCompletion(
    streamCtx: ExecStreamContext,
    options: JobExecutionOptions,
  ): Promise<RunnerOutcome> {
    const { stream, stdout, stderrLines } = streamCtx;
    const stepResults: SandboxStepResult[] = [];
    /** Track step names from step.start messages (stepIndex -> name). */
    const stepNames = new Map<number, string>();
    const state: MutableRunnerState = {
      jobStatus: ExecutionJobStatus.enum.failed,
      jobOutputs: undefined,
      encryptedSecretOutputs: undefined,
    };

    return new Promise<RunnerOutcome>((resolve, reject) => {
      // Parse JSON-lines from stdout using readline.
      const rl = createInterface({ input: stdout, crlfDelay: Infinity });

      rl.on('line', (line) => {
        let msg: RunnerToAgentMessage;
        try {
          msg = JSON.parse(line) as RunnerToAgentMessage;
        } catch {
          // Not valid JSON -- treat as raw output, log as warning.
          logger.warn('Non-JSON output from runner', { line: line.slice(0, 200) });
          return;
        }

        if (this.dispatchRunnerMessage(msg, stream, options, stepNames, stepResults, state)) {
          resolve({
            jobStatus: state.jobStatus,
            stepResults,
            jobOutputs: state.jobOutputs,
            encryptedSecretOutputs: state.encryptedSecretOutputs,
          });
        }
      });

      rl.on('close', () => {
        // Readline closed -- exec may have exited.
        // If we haven't received job.complete, this is a crash.
        if (state.jobStatus === ExecutionJobStatus.enum.failed && stepResults.length === 0) {
          const stderrTail = stderrLines.join('\n');
          reject(
            new Error(
              `Workflow runner exited without sending job.complete. ` +
                `stderr (last ${MAX_STDERR_LINES} lines):\n${stderrTail}`,
            ),
          );
        } else {
          // We already resolved or have partial results.
          resolve({
            jobStatus: state.jobStatus,
            stepResults,
            jobOutputs: state.jobOutputs,
            encryptedSecretOutputs: state.encryptedSecretOutputs,
          });
        }
      });

      rl.on('error', (err) => {
        reject(new Error(`Stdout readline error: ${err.message}`));
      });
    });
  }

  /**
   * Dispatch one parsed RunnerToAgentMessage. Mutates `state`, `stepNames`,
   * and `stepResults` in place; writes responses back through `stream` for
   * the relay messages (event.emit / concurrency.report / agent.api.request).
   *
   * Returns `true` when the caller should resolve the awaitJobCompletion
   * promise (only for `job.complete`); `false` otherwise.
   */
  private dispatchRunnerMessage(
    msg: RunnerToAgentMessage,
    stream: NodeJS.ReadWriteStream,
    options: JobExecutionOptions,
    stepNames: Map<number, string>,
    stepResults: SandboxStepResult[],
    state: MutableRunnerState,
  ): boolean {
    switch (msg.type) {
      case 'ready':
        // Runner is ready, send the execution request.
        this.sendExecuteRequest(stream, options);
        return false;

      case 'step.start': {
        stepNames.set(msg.stepIndex, msg.stepName);
        const startState =
          msg.state === 'pending'
            ? ExecutionStepStatus.enum.pending
            : ExecutionStepStatus.enum.running;
        const startData = {
          ...(msg.concurrencyKind && { concurrencyKind: msg.concurrencyKind }),
          ...(msg.groupId && { groupId: msg.groupId }),
        };
        if (Object.keys(startData).length > 0) {
          options.onStepStatus(msg.stepIndex, msg.stepName, startState, startData);
        } else {
          options.onStepStatus(msg.stepIndex, msg.stepName, startState);
        }
        return false;
      }

      case 'step.complete': {
        const name = stepNames.get(msg.stepIndex) ?? `step-${msg.stepIndex}`;
        options.onStepStatus(msg.stepIndex, name, msg.status, {
          durationMs: msg.durationMs,
          ...(msg.error && { error: msg.error }),
          ...(msg.secretsAccessed && { secretsAccessed: msg.secretsAccessed }),
          ...(msg.step_type && { step_type: msg.step_type }),
          ...(msg.checkOutcome !== undefined && { checkOutcome: msg.checkOutcome }),
          ...(msg.driftSummary !== undefined && { driftSummary: msg.driftSummary }),
          ...(msg.drift !== undefined && { drift: msg.drift }),
          ...(msg.concurrencyKind && { concurrencyKind: msg.concurrencyKind }),
          ...(msg.groupId && { groupId: msg.groupId }),
          ...(msg.data && msg.data),
        });

        // Track step results.
        stepResults.push({
          name,
          stepIndex: msg.stepIndex,
          status: msg.status,
          durationMs: msg.durationMs,
          ...(msg.error && { error: msg.error }),
        });
        return false;
      }

      case 'log.line':
        options.onLogLine(msg.stepIndex, msg.line);
        return false;

      case 'step.secret_mount':
        options.onSecretMount?.({
          stepIndex: msg.stepIndex,
          sources: msg.sources,
          target: msg.target,
          kind: msg.kind,
          ...(msg.envVar !== undefined && { envVar: msg.envVar }),
        });
        return false;

      case 'event.emit':
        relayEventEmit(stream, options, msg as EventEmitRequest);
        return false;

      case 'concurrency.report':
        relayConcurrencyReport(stream, options, msg as ConcurrencyReportMessage);
        return false;

      case 'agent.api.request':
        relayApiRequest(stream, options, msg as AgentApiRequestIpc);
        return false;

      case 'cache.request':
        relayCacheRequest(stream, options, msg as CacheRequestIpc);
        return false;

      case 'provenance.request':
        relayProvenanceRequest(stream, options, msg as ProvenanceRequestIpc);
        return false;

      case 'approval.request':
        relayApprovalRequest(stream, options, msg as StepApprovalRequestIpc);
        return false;

      case 'job.complete':
        applyJobComplete(msg, stepResults, state, options);
        return true;

      default:
        logger.warn('Unrecognized IPC message from container runner', {
          type: (msg as Record<string, unknown>).type,
        });
        return false;
    }
  }

  /**
   * Phase 3 of executeJob: apply abort-signal short-circuit, set jobFailed,
   * and assemble the final JobExecutionResult.
   */
  private buildExecutionResult(
    outcome: RunnerOutcome,
    options: JobExecutionOptions,
    startTime: number,
  ): JobExecutionResult {
    let { jobStatus } = outcome;

    // Check if job was cancelled via abort signal.
    if (options.signal.aborted) {
      jobStatus = ExecutionJobStatus.enum.cancelled;
    }

    // jobStatus is mutated inside the readline callback; TypeScript control flow
    // cannot track it across the async boundary, so we cast to the full union.
    const finalStatus = jobStatus as 'success' | 'failed' | 'cancelled';
    this.jobFailed = finalStatus !== ExecutionJobStatus.enum.success;

    return {
      status: finalStatus,
      stepResults: outcome.stepResults,
      durationMs: Date.now() - startTime,
      ...(outcome.jobOutputs && { outputs: outcome.jobOutputs }),
      ...(outcome.encryptedSecretOutputs && { secretOutputs: outcome.encryptedSecretOutputs }),
    };
  }

  // --- Lifecycle: abort ---

  async abort(): Promise<void> {
    await this.handleAbort();
  }

  // --- Lifecycle: teardown ---

  async teardown(): Promise<void> {
    if (!this.container) return;

    if (this.keepFailed && this.jobFailed) {
      logger.info('Keeping failed container for debugging', {
        name: this.containerName,
        containerId: this.container.id.slice(0, 12),
      });
      this.container = null;
      return;
    }

    logger.info('Tearing down sandbox container', {
      name: this.containerName,
    });

    try {
      await this.container.stop({ t: CONTAINER_STOP_TIMEOUT });
    } catch {
      // Container may already be stopped.
    }

    try {
      await this.container.remove({ force: true });
    } catch {
      // Container may already be removed.
    }

    this.container = null;
  }

  // --- Internal helpers ---

  /**
   * Send the execute request to the workflow runner via the exec's stdin.
   *
   * The runner in stdio mode reads from stdin. We write a single JSON object
   * (the execute message) followed by a newline, then signal end of input.
   *
   * Reuses buildRequest() from fork-runner.ts to ensure consistent field
   * mapping from JobDispatch to JobExecutionRequest.
   */
  private sendExecuteRequest(stream: NodeJS.ReadWriteStream, options: JobExecutionOptions): void {
    // workDir is /workspace inside the container (bind-mounted from host).
    const request = buildRequest(options.dispatch, '/workspace');
    const msg: AgentToRunnerMessage = { type: 'execute', request };
    stream.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Handle abort: write abort message to stdin, wait for grace period,
   * then kill the container if still running.
   */
  private async handleAbort(): Promise<void> {
    if (!this.execStream && !this.container) return;

    logger.info('Aborting sandbox execution', { name: this.containerName });

    // Try writing abort message to stdin (runner listens for this in fork mode,
    // but in container mode SIGTERM is the primary mechanism).
    if (this.execStream) {
      try {
        const abortMsg: AgentToRunnerMessage = { type: 'abort' };
        this.execStream.write(JSON.stringify(abortMsg) + '\n');
      } catch {
        // Stream may already be closed.
      }
    }

    // Wait grace period, then force-stop.
    await new Promise<void>((resolve) => setTimeout(resolve, ABORT_GRACE_MS));

    // If container is still running, force-stop it.
    if (this.container) {
      try {
        await this.container.stop({ t: 0 });
      } catch {
        // Container may already be stopped.
      }
    }
  }
}
