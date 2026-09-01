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
 * The container image does NOT need Node.js or git. KiCI provisions its own
 * runtime — a pinned, official glibc-2.17 Node plus the runner bundle, mounted
 * read-only at /opt/kici — and launches the runner with THAT node. The image
 * needs only a glibc and a shell, which the preflight asserts before the
 * container is created.
 */

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Docker from 'dockerode';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ensureRuntimeVolume, RuntimeSubtree } from '@kici-dev/shared/container-runtime';
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
  GitGrantRequestIpc,
  ProvenanceRequestIpc,
  ArtifactRequestIpc,
  StepApprovalRequestIpc,
} from './ipc-protocol.js';
import { buildRequest } from './fork-runner.js';
import { runnerLaunchArgv, KICI_RUNTIME_NODE_DIR } from './kici-runtime.js';
import { assertImageRunnable } from './image-preflight.js';
import { c as tarCreate } from 'tar';
import { encryptSecretOutputs } from './secret-encryption.js';
import { buildContainerHardening, type SandboxHardeningOptions } from './container-hardening.js';

const logger = createLogger({ prefix: 'container-sandbox' });

/** Maximum lines of stderr to keep for crash diagnostics. */
const MAX_STDERR_LINES = 20;

/** Grace period (ms) to wait for graceful abort before killing. */
const ABORT_GRACE_MS = 10_000;

/** Stop timeout (seconds) for container stop. */
const CONTAINER_STOP_TIMEOUT = 10;

/** Fixed mount target for the pure-JS container loader hook bundle. */
const HOOK_MOUNT_PATH = '/opt/kici/ts-loader-hook.js';

/**
 * Agent-internal env vars the sandbox always sets on the container + each exec.
 * They are NOT customer-derived: they point the in-container runner at the
 * mounted loader hook and route runner-internal logs to stderr (fd2) so they
 * cannot corrupt the fd1 JSON-lines IPC channel that container/stdio mode uses.
 */
const INTERNAL_ENV = [`KICI_TS_LOADER_HOOK_PATH=${HOOK_MOUNT_PATH}`, 'KICI_LOG_STDERR=1'];

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
  /**
   * Pre-provisioned KiCI Node tree (the directory whose `bin/node` is the
   * injected runtime), bind-mounted read-only at `/opt/kici/node`. A HOST
   * path, or the name of a volume already holding the tree.
   *
   * When supplied, the runner launches on THAT node and the image needs no
   * Node of its own. Wins over `runtimeImage` — a caller that already has the
   * tree should not pay a materialization to get the same one.
   */
  runtimeNodePath?: string;
  /**
   * KiCI agent image carrying `/opt/kici`, from which the Node tree is
   * materialized into a named volume during setup.
   *
   * This is how an agent nesting a job container gets a runtime: a bind mount
   * needs a HOST path, and the agent may itself be containerized, so it cannot
   * assume `/opt/kici` exists on the host filesystem. Copying the tree out of
   * the image into a volume once, then mounting that volume, works either way.
   *
   * Absent (and no `runtimeNodePath`) means no injection: the runner falls
   * back to the image's own `node`, which is the historical contract and still
   * correct for an image that ships one. Both modes are correct; the fallback
   * is not a workaround for a missing mount but the mode a caller that has no
   * runtime to inject is in.
   */
  runtimeImage?: string;
  /**
   * Tag this sandbox's image was BUILT under, when the job declared a
   * Dockerfile rather than naming an image.
   *
   * Present only for a built image, and removed at teardown — a tag per run
   * would otherwise accumulate on the host forever. Removing the tag leaves the
   * layer cache untouched, which is what makes the next build fast, so this
   * costs nothing but the name.
   */
  buildTag?: string;
  /**
   * Registry credentials for pulling `image`, already resolved by the
   * orchestrator. Absent means an anonymous pull.
   */
  registryAuth?: { username: string; password: string; serveraddress: string };
  /**
   * Path to the pure-JS container loader-hook bundle on the HOST (bind-mounted
   * read-only). Defaults to `container-ts-loader-hook.js` next to `runnerPath`.
   */
  hookPath?: string;
  /** Pre-sanitized environment variables for the container. */
  env: Record<string, string>;
  /** Whether to keep failed containers for debugging. */
  keepFailed?: boolean;
  /** Job ID for container labeling and orphan cleanup. */
  jobId?: string;
  /**
   * Resolved hardening posture for the job container (cap-drop, no-new-privileges,
   * cgroup caps, tmpfs, user, network). When omitted, no hardening is applied —
   * the production caller (job-runner) always supplies this from agent config so
   * the secure-by-default posture is in force; leaving it optional keeps the
   * constructor testable and lets non-production callers opt out explicitly.
   */
  hardening?: SandboxHardeningOptions;
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
 * Relay git.grant.request from the container runner to the agent's grant table
 * via options.onGitGrantRequest, then write the response back through `stream`.
 */
function relayGitGrantRequest(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  grantMsg: GitGrantRequestIpc,
): void {
  const writeResponse = (response: Record<string, unknown>): void => {
    try {
      stream.write(JSON.stringify(response) + '\n');
    } catch {
      // Stream may be closed
    }
  };
  if (!options.onGitGrantRequest) {
    writeResponse({
      type: 'git.grant.response',
      requestId: grantMsg.requestId,
      error: 'Git credentials are not available in this agent configuration',
    });
    return;
  }
  options.onGitGrantRequest(grantMsg).then(
    (response) => writeResponse(response as unknown as Record<string, unknown>),
    (err) =>
      writeResponse({
        type: 'git.grant.response',
        requestId: grantMsg.requestId,
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
 * Relay artifacts.request from the container runner to the orchestrator via
 * options.onArtifactRequest, then write the response back through `stream`. If
 * the agent doesn't expose an artifacts relay, write a structured error so the
 * runner doesn't hang.
 */
function relayArtifactRequest(
  stream: NodeJS.ReadWriteStream,
  options: JobExecutionOptions,
  artMsg: ArtifactRequestIpc,
): void {
  const writeResponse = (response: Record<string, unknown>): void => {
    try {
      stream.write(JSON.stringify(response) + '\n');
    } catch {
      // Stream may be closed
    }
  };
  if (!options.onArtifactRequest) {
    writeResponse({
      type: 'artifacts.response',
      requestId: artMsg.requestId,
      error: 'Artifacts not available in this agent configuration',
    });
    return;
  }
  options.onArtifactRequest(artMsg).then(
    (response) => writeResponse(response as unknown as Record<string, unknown>),
    (err) =>
      writeResponse({
        type: 'artifacts.response',
        requestId: artMsg.requestId,
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
  private readonly runtimeNodePath: string | undefined;
  private readonly runtimeImage: string | undefined;
  private readonly buildTag: string | undefined;
  /**
   * The runtime actually injected into this job's container — the configured
   * path, or the volume materialized during setup. Resolved once in setup()
   * because materialization needs the container runtime, and read by both the
   * bind list and the runner launch.
   */
  private resolvedRuntimeNode: string | undefined;
  private readonly registryAuth:
    { username: string; password: string; serveraddress: string } | undefined;
  private readonly runnerMountPath: string;
  /** Host path to the pure-JS container loader-hook bundle (bind-mounted :ro). */
  private readonly hookHostPath: string;
  private readonly env: Record<string, string>;
  private readonly keepFailed: boolean;
  private readonly jobId: string;
  private readonly hardening?: SandboxHardeningOptions;
  /** Resolved container user (image-user override / grant), applied to createContainer + each exec. */
  private resolvedUser?: string;

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
    this.runtimeNodePath = options.runtimeNodePath;
    this.runtimeImage = options.runtimeImage;
    this.buildTag = options.buildTag;
    this.registryAuth = options.registryAuth;
    this.runnerMountPath = options.runnerMountPath ?? '/opt/kici/workflow-runner.js';
    this.hookHostPath =
      options.hookPath ?? join(dirname(options.runnerPath), 'container-ts-loader-hook.js');
    this.env = options.env;
    this.keepFailed = options.keepFailed ?? false;
    this.jobId = options.jobId ?? `unknown-${Date.now()}`;
    this.hardening = options.hardening;
  }

  // --- Lifecycle: setup ---

  /**
   * Ensure the job's container image is present locally, pulling it on demand
   * when it is not.
   *
   * dockerode's `createContainer` — unlike `docker run` / `podman run` — never
   * auto-pulls a missing image; it fails with `(HTTP code 404) ... No such
   * image`. A bare-metal executor that aggressively prunes unused images under
   * disk pressure can leave a container job with nothing to run, so the agent
   * pulls the image itself. Already-present images (the common case, and how
   * private images pre-pulled with registry auth stay working) skip the pull.
   */
  private async ensureImagePresent(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch {
      // Not present locally — pull it below.
    }

    // The authconfig is deliberately absent from this line — it carries a
    // registry password, and this log reaches run output.
    logger.info('Pulling sandbox image (not present locally)', {
      image: this.image,
      authenticated: this.registryAuth !== undefined,
    });
    const stream = await this.docker.pull(
      this.image,
      this.registryAuth ? { authconfig: this.registryAuth } : {},
    );
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
    logger.info('Sandbox image pulled', { image: this.image });
  }

  /**
   * Resolve the Node tree to inject into the job container, materializing it
   * when only an image was configured.
   *
   * A configured path wins: a caller that already provisioned the tree should
   * not pay a copy to arrive at the same one. Returning `undefined` is a real
   * outcome, not a failure — an agent with no runtime source runs the job on
   * the image's own `node`, which is what a `node:*` image was always doing.
   *
   * A materialization that FAILS is not softened into that outcome. Continuing
   * would start the job against an image the operator never claimed ships Node,
   * and the resulting "node: not found" says nothing about the runtime that was
   * supposed to be there.
   */
  private async resolveRuntimeNode(): Promise<string | undefined> {
    if (this.runtimeNodePath) return this.runtimeNodePath;
    if (!this.runtimeImage) return undefined;

    return await ensureRuntimeVolume({
      docker: this.docker,
      agentImage: this.runtimeImage,
      // The node tree ALONE. The runner bundle and the loader hook are bound
      // from this agent's own build, at fixed paths under /opt/kici — mounting
      // the whole tree there would put those two binds inside a read-only
      // mount, whose mountpoints cannot be created. Binding the agent's own
      // runner is also what keeps the runner and the agent driving it from
      // ever being two different versions.
      subtree: RuntimeSubtree.enum.node,
      onProgress: (message) => logger.info(message, { jobId: this.jobId }),
    });
  }

  async setup(options: SandboxSetupOptions): Promise<void> {
    this.containerName = `kici-sandbox-${this.jobId}-${Date.now()}`;

    // Build env array (key=value format) from sanitized env.
    // This env has already been processed by buildSanitizedEnv() -- NO agent credentials.
    // The two INTERNAL_ENV entries (loader-hook path + stderr routing) are
    // agent-owned, never customer-derived.
    const envArray = [...Object.entries(this.env).map(([k, v]) => `${k}=${v}`), ...INTERNAL_ENV];

    logger.info('Creating sandbox container', {
      name: this.containerName,
      image: this.image,
      workDir: options.workDir,
    });

    // Resolve the hardening posture (cap-drop, no-new-privileges, cgroup caps,
    // tmpfs, user, network). Merged into the HostConfig below; the resolved
    // user (if any) is applied top-level and re-applied on each exec.
    const hardened = this.hardening
      ? buildContainerHardening(this.hardening)
      : { hostConfig: {} as Partial<Docker.HostConfig>, user: undefined };
    this.resolvedUser = hardened.user;

    // Resolve the runtime BEFORE the bind list, which mounts it. A configured
    // path is taken verbatim; otherwise the tree is materialized out of the
    // agent image into a named volume, reused across every later job on this
    // host that shares the image.
    this.resolvedRuntimeNode = await this.resolveRuntimeNode();

    const binds = this.buildBinds(options, hardened.hostConfig);

    // Ensure the image is present before createContainer — dockerode does NOT
    // auto-pull a missing image (the `docker`/`podman run` CLI does), so a job
    // whose image was never pulled, or was reaped by a disk-pressure image
    // prune, fails with a 404 "No such image" instead of running.
    await this.ensureImagePresent();

    // AFTER the pull, never before: the probe creates a container from the
    // image, which a not-yet-pulled image cannot satisfy. Only when we inject
    // the runtime — the glibc requirement exists BECAUSE a glibc-linked node
    // is mounted in, so a job supplying its own node from the image is
    // unaffected and preflighting it would reject images that work.
    if (this.resolvedRuntimeNode) {
      await assertImageRunnable(this.docker, this.image);
    }

    // Create container:
    // - sleep infinity keeps it alive for the entire job
    // - /workspace is a container-owned anonymous volume (`Volumes`), created
    //   fresh and owned by the container user — NOT a host bind. This dissolves
    //   the host-uid ↔ container-uid ownership conflict that made a read-write
    //   host bind unwritable under rootful docker once `CapDrop: ['ALL']` removes
    //   CAP_DAC_OVERRIDE. The clone/install/execute all run inside the container,
    //   so the host workDir is never read back — a private volume is sufficient.
    // - Workflow runner bind-mounted read-only
    // - file:// clone-source dir(s) and (under host networking) the host's
    //   name-resolution files bind-mounted read-only — see buildBinds
    // - Hardening posture (cap-drop ALL, no-new-privileges, cgroup caps, tmpfs
    //   /tmp) merged from buildContainerHardening
    this.container = await this.docker.createContainer({
      Image: this.image,
      name: this.containerName,
      Cmd: ['sleep', 'infinity'],
      Env: envArray,
      WorkingDir: '/workspace',
      Volumes: { '/workspace': {} },
      ...(hardened.user ? { User: hardened.user } : {}),
      Labels: {
        'kici-sandbox': 'true',
        'kici-job-id': this.jobId,
      },
      HostConfig: {
        Binds: binds,
        ...hardened.hostConfig,
      },
    });

    await this.container.start();

    logger.info('Sandbox container started', {
      name: this.containerName,
      containerId: this.container.id.slice(0, 12),
    });

    if (options.workspaceFromHost) {
      await this.copyWorkspaceIn(options.workDir);
    }
  }

  /**
   * Populate the container's `/workspace` volume from the host working tree.
   *
   * `/workspace` is a container-owned anonymous volume rather than a host bind,
   * which is what dissolves the host-uid vs container-uid conflict once
   * `CapDrop: ['ALL']` removes CAP_DAC_OVERRIDE — so the tree is streamed in as
   * a tar rather than mounted.
   *
   * A failure here is fatal on purpose. Swallowing it would start the job
   * against an EMPTY workspace, which surfaces as a baffling "file not found"
   * in whichever step happens to touch the repo first.
   */
  private async copyWorkspaceIn(workDir: string): Promise<void> {
    const started = Date.now();
    try {
      // `portable` drops uid/gid and mtime noise so the archive lands owned by
      // the container user rather than replaying host ownership.
      const stream = tarCreate({ cwd: workDir, portable: true }, ['.']);

      // The stream errors ASYNCHRONOUSLY (an unreadable or missing workDir
      // surfaces after tarCreate returned), so without racing it the failure
      // escapes this try/catch and the job starts on an empty workspace.
      const streamFailed = new Promise<never>((_, reject) => {
        stream.on('error', reject);
      });
      await Promise.race([
        (
          this.container as unknown as {
            putArchive(s: unknown, o: { path: string }): Promise<unknown>;
          }
        ).putArchive(stream, { path: '/workspace' }),
        streamFailed,
      ]);
    } catch (err) {
      throw new Error(
        `Failed to copy the host workspace into the sandbox container: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    logger.info('Copied host workspace into sandbox', {
      name: this.containerName,
      durationMs: Date.now() - started,
    });
  }

  /**
   * Build the container's read-only bind list.
   *
   * The workspace is NOT bound here — it is a container-owned anonymous volume
   * (`Volumes: { '/workspace': {} }` on the container config), so the container
   * user can write it on every runtime with `CapDrop: ['ALL']` intact. This
   * method binds the workflow runner (read-only) plus two parity affordances
   * that mirror the bare-metal bwrap sandbox — both strictly additive and gated,
   * so the default posture for a production (https-source, bridge-network) job is
   * unchanged:
   *
   * - **`file://` clone-source dir(s)** (`options.extraReadOnlyBinds`): the
   *   workflow runner clones the repo from inside the container, so a local
   *   `file://` source dir must be exposed read-only or `git clone` fails.
   *   Empty for https/ssh remotes — mirrors fork-runner's `extraReadOnlyBinds`.
   * - **Host name-resolution files under host networking**: when the effective
   *   network posture is `host` (`KICI_SANDBOX_NETWORK=host`, or a per-job host
   *   grant), bind the host's `/etc/hosts` (+ `/etc/nsswitch.conf`) read-only so
   *   an `/etc/hosts`-only name the host resolves — e.g. a private registry —
   *   resolves inside the container too. Mirrors fork-runner's
   *   `--ro-bind /etc/hosts` for the bwrap host-network mode.
   */
  private buildBinds(
    options: SandboxSetupOptions,
    hostConfig: Partial<Docker.HostConfig>,
  ): string[] {
    const binds = [
      `${this.runnerPath}:${this.runnerMountPath}:ro`,
      `${this.hookHostPath}:${HOOK_MOUNT_PATH}:ro`,
    ];

    // Read-only: a job must not be able to rewrite the runtime it runs under.
    if (this.resolvedRuntimeNode) {
      binds.push(`${this.resolvedRuntimeNode}:${KICI_RUNTIME_NODE_DIR}:ro`);
    }

    for (const dir of options.extraReadOnlyBinds ?? []) {
      if (dir) binds.push(`${dir}:${dir}:ro`);
    }

    if (hostConfig.NetworkMode === 'host') {
      for (const nssFile of ['/etc/hosts', '/etc/nsswitch.conf']) {
        if (existsSync(nssFile)) binds.push(`${nssFile}:${nssFile}:ro`);
      }
    }

    return binds;
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
    // Plus the agent-owned INTERNAL_ENV (loader-hook path + stderr routing).
    const execEnv = [...Object.entries(this.env).map(([k, v]) => `${k}=${v}`), ...INTERNAL_ENV];

    // Create exec inside the running container. The runner process (and every
    // workflow step it spawns) inherits the container's hardened posture —
    // CapDrop ALL, no-new-privileges, and the cgroup caps — because the runtime
    // copies the container's process spec into each exec; the dockerode exec API
    // exposes no per-exec capability/no-new-privileges fields to re-assert them.
    // The scaler-container `sandbox-hardening-defaults` E2E probes /proc/self/status
    // from inside this exec, so a runtime that ever stopped inheriting the posture
    // would fail that test loudly. Re-apply the resolved user explicitly since some
    // runtimes do not inherit the container's configured user into exec.
    const exec = await this.container!.exec({
      Cmd: this.resolvedRuntimeNode
        ? runnerLaunchArgv(this.runnerMountPath)
        : ['node', this.runnerMountPath],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Env: execEnv,
      WorkingDir: '/workspace',
      ...(this.resolvedUser ? { User: this.resolvedUser } : {}),
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
        options.onLogLine(msg.stepIndex, msg.line, msg.stream);
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

      case 'git.grant.request':
        relayGitGrantRequest(stream, options, msg as GitGrantRequestIpc);
        return false;

      case 'cache.request':
        relayCacheRequest(stream, options, msg as CacheRequestIpc);
        return false;

      case 'artifacts.request':
        relayArtifactRequest(stream, options, msg as ArtifactRequestIpc);
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

      case 'hooks-declared':
      case 'completion-hooks-done':
        // Between-jobs lifecycle markers. The container backend reaps the whole
        // tree (and external state) on teardown, so it needs no out-of-band
        // re-run — acknowledge the markers without acting on them.
        return false;

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

  /**
   * Drop the tag a `container.dockerfile` build produced.
   *
   * Best-effort: teardown must not fail a job that already finished. The LAYER
   * cache — the thing that makes the next build fast — is not a tag and is
   * untouched by this.
   */
  private async reclaimBuiltImage(): Promise<void> {
    if (!this.buildTag) return;
    try {
      await this.docker.getImage(this.buildTag).remove({ force: true });
    } catch {
      // Already gone, or still referenced by something we do not own.
    }
  }

  async teardown(): Promise<void> {
    // Before the early return, not after: a setup that failed AFTER the build —
    // an image preflight rejecting a musl base, say — leaves a tag and no
    // container, and that tag would otherwise stay on the host forever.
    if (!this.container) {
      await this.reclaimBuiltImage();
      return;
    }

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
      // `v: true` removes the container-owned anonymous /workspace volume along
      // with the container (the keepFailed early-return above keeps both).
      await this.container.remove({ force: true, v: true });
    } catch {
      // Container may already be removed.
    }

    // A built image's tag is per-run, so leaving it behind accumulates one dead
    // tag per job on the host. The keepFailed early-return above deliberately
    // skips this: a container kept for debugging needs its image kept too.
    await this.reclaimBuiltImage();

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
    // workDir is /workspace inside the container — a container-owned anonymous
    // volume the runner clones into (not a host bind).
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
