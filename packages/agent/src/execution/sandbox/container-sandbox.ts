/**
 * Container execution sandbox: the strongest isolation model. The agent stays
 * on the host; the whole job (clone, dependency install, compile, steps) runs
 * in a disposable Docker/Podman container that lives for the job
 * (`sleep infinity`), talking JSON-lines over the demuxed exec stdin/stdout.
 *
 * - The workflow runner is bind-mounted read-only.
 * - Agent-internal credentials (KICI_*, KICI_DATABASE_URL, etc.) NEVER enter the container.
 * - The image needs no Node.js or git: KiCI mounts a pinned, official
 *   glibc-2.17 Node plus the runner bundle read-only at /opt/kici and launches
 *   the runner with THAT node. The image needs only a glibc and a shell, which
 *   the preflight asserts before the container is created.
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
import { createDepRestoreReportRelay, type DepRestoreReportRelay } from '../dep-restore-report.js';
import { runnerLaunchArgv, KICI_RUNTIME_NODE_DIR } from './kici-runtime.js';
import { assertImageRunnable } from './image-preflight.js';
import { describeRunnerCrash, MAX_RAW_STDOUT_LINES, pushBounded } from './runner-crash.js';
import { c as tarCreate } from 'tar';
import { singleLinkTarCaches } from '@kici-dev/core/tar-single-link';
import { encryptSecretOutputs } from './secret-encryption.js';
import { buildContainerHardening, type SandboxHardeningOptions } from './container-hardening.js';
import {
  applyJobEgressRules,
  ensureJobNetwork,
  JOB_NETWORK_NAME,
  removeJobEgressRules,
} from './job-network.js';

const logger = createLogger({ prefix: 'container-sandbox' });

/** Maximum lines of stderr to keep for crash diagnostics. */
const MAX_STDERR_LINES = 20;

/** How long (ms) a crash report waits on the exec inspect before reporting an unknown exit code. */
const CRASH_INSPECT_TIMEOUT_MS = 5_000;

/** Grace period (ms) for a graceful abort before killing. */
const ABORT_GRACE_MS = 10_000;

/** Container stop timeout (seconds). */
const CONTAINER_STOP_TIMEOUT = 10;

/** Mount target of the pure-JS container loader hook bundle. */
const HOOK_MOUNT_PATH = '/opt/kici/ts-loader-hook.js';

/**
 * Agent-internal (not customer-derived) env set on the container and each
 * exec: points the runner at the mounted loader hook, and routes runner logs
 * to stderr so they cannot corrupt the fd1 JSON-lines IPC channel.
 */
const INTERNAL_ENV = [`KICI_TS_LOADER_HOOK_PATH=${HOOK_MOUNT_PATH}`, 'KICI_LOG_STDERR=1'];

// --- Options ---

interface ContainerSandboxOptions {
  /** From the orchestrator/scaler, or created locally. */
  docker: Docker;
  /** From the job config or the scaler label-set. */
  image: string;
  /** workflow-runner.js on the HOST (bind-mounted). */
  runnerPath: string;
  /** Default: /opt/kici/workflow-runner.js. */
  runnerMountPath?: string;
  /**
   * Pre-provisioned KiCI Node tree (whose `bin/node` is the injected runtime),
   * bind-mounted read-only at `/opt/kici/node`: a HOST path, or a volume
   * already holding the tree. The runner then launches on THAT node. Wins over
   * `runtimeImage`, so a caller holding the tree skips a materialization.
   */
  runtimeNodePath?: string;
  /**
   * KiCI agent image carrying `/opt/kici`, whose Node tree setup materializes
   * into a named volume. A nesting agent may itself be containerized, so it
   * cannot bind-mount a HOST `/opt/kici`; a volume works either way.
   *
   * Absent (and no `runtimeNodePath`): no injection, and the runner uses the
   * image's own `node` — a correct mode for a caller with no runtime to
   * inject, not a workaround for a missing mount.
   */
  runtimeImage?: string;
  /**
   * Tag a job-declared Dockerfile was BUILT under; present only for a built
   * image. Removed at teardown so per-run tags do not accumulate; the layer
   * cache that makes the next build fast survives.
   */
  buildTag?: string;
  /** Pull credentials, resolved by the orchestrator. Absent: anonymous pull. */
  registryAuth?: { username: string; password: string; serveraddress: string };
  /**
   * Pure-JS loader-hook bundle on the HOST (bind-mounted read-only). Defaults
   * to `container-ts-loader-hook.js` next to `runnerPath`.
   */
  hookPath?: string;
  /** Pre-sanitized. */
  env: Record<string, string>;
  /** Keep failed containers for debugging. */
  keepFailed?: boolean;
  /** For container labeling and orphan cleanup. */
  jobId?: string;
  /**
   * Hardening posture (cap-drop, no-new-privileges, cgroup caps, tmpfs, user,
   * network). Omitted means none: the production caller (job-runner) always
   * supplies it from agent config; optional only for tests and explicit
   * non-production opt-out.
   */
  hardening?: SandboxHardeningOptions;
  /**
   * Apply RFC1918 + cloud-metadata egress filtering to the job container
   * (`KICI_SANDBOX_NETWORK_ISOLATION`, default on). Ignored when the effective
   * network is `host` or `none` — neither has a bridge IP to key rules on.
   */
  networkIsolation?: boolean;
}

// --- Internal helper types ---

/** Returned by attachExecStream; the caller closes `stderrRl` and detaches `abortHandler`. */
interface ExecStreamContext {
  exec: Docker.Exec;
  stream: NodeJS.ReadWriteStream;
  stdout: PassThrough;
  stderrLines: string[];
  stderrRl: ReturnType<typeof createInterface>;
  abortHandler: () => void;
}

/** Mutated by dispatchRunnerMessage; `awaitJobCompletion` resolves with a snapshot. */
interface MutableRunnerState {
  jobStatus: 'success' | 'failed' | 'cancelled';
  /** The failure reason the runner reported on job.complete. */
  reportedError: string | undefined;
  /** Sibling jobs the runner dropped for lock drift, reported on job.complete. */
  droppedJobs: string[] | undefined;
  jobOutputs: Record<string, Record<string, unknown>> | undefined;
  encryptedSecretOutputs: Record<string, { agentPublicKey: string; encrypted: string }> | undefined;
  /** Writes the runner's setup-time dep-restore report to the agent log. */
  depRestoreRelay: DepRestoreReportRelay;
}

/** The runner's final state, taken just before the abort-signal short-circuit fires. */
interface RunnerOutcome {
  jobStatus: 'success' | 'failed' | 'cancelled';
  stepResults: SandboxStepResult[];
  /** Why the runner crashed, when it exited without sending job.complete. */
  error?: string;
  /** The failure reason the runner reported on job.complete. */
  reportedError?: string;
  /** Sibling jobs the runner dropped for lock drift. */
  droppedJobs?: string[];
  jobOutputs: Record<string, Record<string, unknown>> | undefined;
  encryptedSecretOutputs: Record<string, { agentPublicKey: string; encrypted: string }> | undefined;
}

/**
 * End the demuxed stdout / stderr passthroughs when the hijacked exec stream
 * ends, closes, or errors. The demuxer only forwards 'data' and never ends its
 * outputs, so without this a runner that exits without job.complete leaves the
 * stdout readline open and the job waiting forever.
 */
function endOutputsWithStream(
  stream: NodeJS.ReadWriteStream,
  stdout: PassThrough,
  stderr: PassThrough,
): void {
  const endOutputs = () => {
    if (!stdout.writableEnded) stdout.end();
    if (!stderr.writableEnded) stderr.end();
  };
  stream.once('end', endOutputs);
  stream.once('close', endOutputs);
  stream.once('error', (err: Error) => {
    logger.warn('Runner exec stream errored', { error: toErrorMessage(err) });
    endOutputs();
  });
}

/** Relay event.emit; an error returns as a structured response, not a rejection. */
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

/** Relay concurrency.report to the orchestrator; an error returns a synthetic `cancel` ack. */
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

/** Relay agent.api.request; with no relay, answer with an error so the runner does not hang. */
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

/** Relay cache.request; with no relay, answer with an error so the runner does not hang. */
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

/** Relay git.grant.request to the agent's grant table (not the orchestrator). */
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
/** Relay provenance.request; with no relay, answer with an error so the runner does not hang. */
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

/** Relay artifacts.request; with no relay, answer with an error so the runner does not hang. */
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

/** Relay approval.request; with no relay (or a throw), fail closed so the runner never hangs. */
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

/** Apply job.complete; secret outputs are encrypted only when the run has a public key. */
function applyJobComplete(
  msg: Extract<RunnerToAgentMessage, { type: 'job.complete' }>,
  stepResults: SandboxStepResult[],
  state: MutableRunnerState,
  options: JobExecutionOptions,
): void {
  state.jobStatus = msg.status;
  // A runner that fails before its first step (clone, deps, compile, rules)
  // reports the reason only here.
  state.reportedError = msg.error;
  state.droppedJobs = msg.droppedJobs;

  // The runner's list is authoritative when it has steps step.complete never
  // reported (e.g. skipped steps reported in bulk).
  if (msg.stepResults && msg.stepResults.length > stepResults.length) {
    stepResults.length = 0;
    stepResults.push(...msg.stepResults);
  }

  if (msg.outputs) {
    state.jobOutputs = msg.outputs;
  }

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
   * The injected runtime: the configured path, or the volume materialized in
   * setup() (which needs the container runtime). Read by the bind list and the
   * runner launch.
   */
  private resolvedRuntimeNode: string | undefined;
  private readonly registryAuth:
    { username: string; password: string; serveraddress: string } | undefined;
  private readonly runnerMountPath: string;
  private readonly hookHostPath: string;
  private readonly env: Record<string, string>;
  private readonly keepFailed: boolean;
  private readonly jobId: string;
  private readonly hardening?: SandboxHardeningOptions;
  private readonly networkIsolation: boolean;
  /** Container IP the applied egress rules are keyed on; unset when none were applied. */
  private egressRuleIp: string | undefined;
  /** Image-user override / grant, applied to createContainer and each exec. */
  private resolvedUser?: string;

  private container: Docker.Container | null = null;
  /** Set during executeJob; used for abort. */
  private execStream: NodeJS.ReadWriteStream | null = null;
  /** Read by teardown for keepFailed. */
  private jobFailed = false;
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
    this.networkIsolation = options.networkIsolation ?? true;
  }

  // --- Lifecycle: setup ---

  /**
   * Pull the job image when it is not present locally. dockerode's
   * `createContainer`, unlike `docker run` / `podman run`, never auto-pulls
   * (`(HTTP code 404) ... No such image`), and a disk-pressure image prune can
   * remove it. A present image (including one pre-pulled with registry auth)
   * skips the pull.
   */
  private async ensureImagePresent(): Promise<void> {
    try {
      await this.docker.getImage(this.image).inspect();
      return;
    } catch {
      // Not present locally — pull it below.
    }

    // Never log the authconfig: it carries a registry password, and this log
    // reaches run output.
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
   * Resolve the Node tree to inject: a configured path wins (no copy), else it
   * is materialized from `runtimeImage`. `undefined` (no runtime source) is a
   * real outcome: the job runs on the image's own `node`.
   *
   * A FAILED materialization throws rather than falling back: the fallback
   * would run an image nobody claimed ships Node, and its "node: not found"
   * says nothing about the missing runtime.
   */
  private async resolveRuntimeNode(): Promise<string | undefined> {
    if (this.runtimeNodePath) return this.runtimeNodePath;
    if (!this.runtimeImage) return undefined;

    return await ensureRuntimeVolume({
      docker: this.docker,
      agentImage: this.runtimeImage,
      // The node tree ALONE. The runner bundle and loader hook are bound from
      // this agent's own build at fixed /opt/kici paths: a whole-tree mount
      // would put those binds inside a read-only mount, whose mountpoints
      // cannot be created. It also keeps runner and agent the same version.
      subtree: RuntimeSubtree.enum.node,
      onProgress: (message) => logger.info(message, { jobId: this.jobId }),
    });
  }

  async setup(options: SandboxSetupOptions): Promise<void> {
    this.containerName = `kici-sandbox-${this.jobId}-${Date.now()}`;

    // this.env went through buildSanitizedEnv(): NO agent credentials.
    const envArray = [...Object.entries(this.env).map(([k, v]) => `${k}=${v}`), ...INTERNAL_ENV];

    logger.info('Creating sandbox container', {
      name: this.containerName,
      image: this.image,
      workDir: options.workDir,
    });

    // Egress filtering applies only to a bridged container: `host` is the host
    // namespace by request and `none` has no egress. The effective network
    // resolves the same way buildContainerHardening does.
    const effectiveNetwork = this.hardening?.grant?.network ?? this.hardening?.networkMode;
    const filterEgress =
      this.networkIsolation && effectiveNetwork !== 'host' && effectiveNetwork !== 'none';
    // A false here means the host cannot filter (no nft / no NET_ADMIN, already
    // warned): the container keeps the runtime's default bridge rather than
    // joining a network whose rules would not exist.
    const egressRulesActive = filterEgress ? await ensureJobNetwork(this.docker) : false;

    const hardened = this.hardening
      ? buildContainerHardening({
          ...this.hardening,
          ...(egressRulesActive ? { jobNetworkName: JOB_NETWORK_NAME } : {}),
        })
      : { hostConfig: {} as Partial<Docker.HostConfig>, user: undefined };
    this.resolvedUser = hardened.user;

    // BEFORE the bind list, which mounts it. A materialized volume is reused by
    // every later job on this host that shares the agent image.
    this.resolvedRuntimeNode = await this.resolveRuntimeNode();

    const binds = this.buildBinds(options, hardened.hostConfig);

    await this.ensureImagePresent();

    // AFTER the pull: the probe creates a container from the image. Only when
    // injecting the runtime — the glibc requirement exists BECAUSE a
    // glibc-linked node is mounted in; preflighting an image that brings its
    // own node would reject images that work.
    if (this.resolvedRuntimeNode) {
      await assertImageRunnable(this.docker, this.image);
    }

    // /workspace is a container-owned anonymous volume, NOT a host bind: under
    // rootful docker a read-write host bind is unwritable by the container uid
    // once `CapDrop: ['ALL']` removes CAP_DAC_OVERRIDE. Everything runs inside
    // the container, so the host workDir is never read back.
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

    if (egressRulesActive) {
      // The default RFC1918 + cloud-metadata drops are ALREADY in the chain,
      // keyed on the job subnet by ensureJobNetwork before this container
      // existed, so the image's ENTRYPOINT never ran outside them.
      //
      // This adds the per-job layer keyed on this container's address, on both
      // hooks: forward rules, and host-access rules allowing DNS on the bridge
      // gateway and no other host service. `undefined` is the forward-hook
      // policy (no per-job allowlist or denyAll). The host set takes no policy
      // at all, so a job cannot widen its own host reachability.
      // addIsolationRules inserts at the chain head, so per-container rules
      // precede the subnet set; a later repair of a partial subnet set
      // re-inserts above them, so a per-job policy must reinstall its rules to
      // keep winning.
      this.egressRuleIp = await applyJobEgressRules(this.docker, this.container.id, undefined);
    }

    logger.info('Sandbox container started', {
      name: this.containerName,
      containerId: this.container.id.slice(0, 12),
    });

    if (options.workspaceFromHost) {
      await this.copyWorkspaceIn(options.workDir);
    }
  }

  /**
   * Stream the host working tree into the `/workspace` volume as a tar (it is
   * a volume, not a bind; see setup()). Fatal on purpose: swallowing a failure
   * would start the job on an EMPTY workspace, surfacing as a baffling "file
   * not found" in whichever step first touches the repo.
   */
  private async copyWorkspaceIn(workDir: string): Promise<void> {
    const started = Date.now();
    try {
      // `portable` drops uid/gid and mtime so files land owned by the container
      // user. The single-link caches copy pnpm `node_modules` hard links in as
      // regular files so node-tar never stalls on them.
      const stream = tarCreate(
        { cwd: workDir, portable: true, ...(await singleLinkTarCaches(workDir, ['.'])) },
        ['.'],
      );

      // The stream errors ASYNCHRONOUSLY (a missing workDir surfaces after
      // tarCreate returns); without the race the failure escapes this catch.
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
   * The read-only bind list (the workspace is a volume, not a bind). Besides
   * the runner, hook and runtime, two gated additions mirror the bare-metal
   * bwrap sandbox and leave a production (https-source, bridge-network) job
   * unchanged:
   *
   * - **`file://` clone-source dir(s)** (`options.extraReadOnlyBinds`): the
   *   runner clones from inside the container, so a local source dir must be
   *   visible or `git clone` fails. Empty for https/ssh remotes.
   * - **`/etc/hosts` and `/etc/nsswitch.conf` under host networking**
   *   (`KICI_SANDBOX_NETWORK=host` or a per-job grant): an `/etc/hosts`-only
   *   name the host resolves (e.g. a private registry) resolves inside too.
   *   Mirrors fork-runner's `--ro-bind /etc/hosts`.
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

    const streamCtx = await this.attachExecStream(options);

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
        error: toErrorMessage(err),
        jobOutputs: undefined,
        encryptedSecretOutputs: undefined,
      };
    } finally {
      options.signal.removeEventListener('abort', streamCtx.abortHandler);
      streamCtx.stderrRl.close();
      this.execStream = null;
    }

    return this.buildExecutionResult(outcome, options, startTime);
  }

  /**
   * Start the runner exec in hijack mode, demux it, keep stderr for crash diagnostics, and
   * install the abort listener.
   */
  private async attachExecStream(options: JobExecutionOptions): Promise<ExecStreamContext> {
    // Same sanitized env as the container: no agent credentials.
    const execEnv = [...Object.entries(this.env).map(([k, v]) => `${k}=${v}`), ...INTERNAL_ENV];

    // The exec (and every step it spawns) inherits CapDrop ALL,
    // no-new-privileges and the cgroup caps, because the runtime copies the
    // container's process spec into each exec; the exec API has no per-exec
    // fields to re-assert them (a step can read CapEff / NoNewPrivs from
    // /proc/self/status). The user IS re-applied: some runtimes do not
    // inherit it into exec.
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

    const stream = await exec.start({ hijack: true, stdin: true });
    this.execStream = stream;

    // Docker multiplexes stdout and stderr into one stream with 8-byte headers.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);
    endOutputsWithStream(stream, stdout, stderr);

    const stderrLines: string[] = [];
    const stderrRl = createInterface({ input: stderr, crlfDelay: Infinity });
    stderrRl.on('line', (line) => {
      stderrLines.push(line);
      if (stderrLines.length > MAX_STDERR_LINES) {
        stderrLines.shift();
      }
    });

    const abortHandler = () => {
      this.handleAbort().catch((err) => {
        logger.warn('Error during abort', {
          error: toErrorMessage(err),
        });
      });
    };
    options.signal.addEventListener('abort', abortHandler, { once: true });

    return { exec, stream, stdout, stderrLines, stderrRl, abortHandler };
  }

  /** Drive the readline IPC loop until job.complete, exec exit, or crash. */
  private awaitJobCompletion(
    streamCtx: ExecStreamContext,
    options: JobExecutionOptions,
  ): Promise<RunnerOutcome> {
    const { stream, stdout, stderrLines } = streamCtx;
    /** Non-JSON stdout: the container runtime writes an exec failure there. */
    const rawStdoutLines: string[] = [];
    const stepResults: SandboxStepResult[] = [];
    /** stepIndex -> name, from step.start. */
    const stepNames = new Map<number, string>();
    const state: MutableRunnerState = {
      jobStatus: ExecutionJobStatus.enum.failed,
      reportedError: undefined,
      droppedJobs: undefined,
      jobOutputs: undefined,
      encryptedSecretOutputs: undefined,
      depRestoreRelay: createDepRestoreReportRelay(this.jobId),
    };

    return new Promise<RunnerOutcome>((resolve, reject) => {
      const rl = createInterface({ input: stdout, crlfDelay: Infinity });
      let completed = false;

      rl.on('line', (line) => {
        let msg: RunnerToAgentMessage;
        try {
          msg = JSON.parse(line) as RunnerToAgentMessage;
        } catch {
          logger.warn('Non-JSON output from runner', { line: line.slice(0, 200) });
          pushBounded(rawStdoutLines, line, MAX_RAW_STDOUT_LINES);
          return;
        }

        if (this.dispatchRunnerMessage(msg, stream, options, stepNames, stepResults, state)) {
          completed = true;
          resolve({
            jobStatus: state.jobStatus,
            stepResults,
            reportedError: state.reportedError,
            droppedJobs: state.droppedJobs,
            jobOutputs: state.jobOutputs,
            encryptedSecretOutputs: state.encryptedSecretOutputs,
          });
        }
      });

      rl.on('close', () => {
        // Closed with no job.complete and no step results: a crash.
        if (
          !completed &&
          state.jobStatus === ExecutionJobStatus.enum.failed &&
          stepResults.length === 0
        ) {
          void this.describeCrash(streamCtx.exec, rawStdoutLines, stderrLines).then((message) =>
            reject(new Error(message)),
          );
        } else {
          // Already resolved, or partial results.
          resolve({
            jobStatus: state.jobStatus,
            stepResults,
            reportedError: state.reportedError,
            droppedJobs: state.droppedJobs,
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

  /** Failure message for a runner that exited without job.complete. */
  private async describeCrash(
    exec: Docker.Exec,
    stdoutTail: string[],
    stderrTail: string[],
  ): Promise<string> {
    let exitCode: number | null | undefined;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), CRASH_INSPECT_TIMEOUT_MS);
    });
    try {
      // A daemon that never answers must not turn a crash back into a hang.
      const info = await Promise.race([exec.inspect(), timedOut]);
      if (info) exitCode = info.ExitCode;
      else logger.warn('Timed out inspecting the crashed runner exec');
    } catch (err) {
      logger.warn('Could not inspect the crashed runner exec', { error: toErrorMessage(err) });
    } finally {
      clearTimeout(timer);
    }
    return describeRunnerCrash({
      image: this.image,
      runtimeInjected: this.resolvedRuntimeNode !== undefined,
      exitCode,
      stdoutTail,
      stderrTail,
    });
  }

  /**
   * Dispatch one runner message, mutating `state`, `stepNames` and
   * `stepResults` in place; relay messages answer through `stream`. Returns
   * `true` only for `job.complete`.
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
        this.sendExecuteRequest(stream, options);
        return false;

      case 'step.start': {
        state.depRestoreRelay.onStepStarted();
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

      case 'dep-restore.report':
        state.depRestoreRelay.relay(msg.report);
        return false;

      case 'job.complete':
        applyJobComplete(msg, stepResults, state, options);
        return true;

      case 'hooks-declared':
      case 'completion-hooks-done':
        // Between-jobs lifecycle markers, ignored: teardown reaps the whole
        // tree (and external state), so no out-of-band re-run is needed.
        return false;

      default:
        logger.warn('Unrecognized IPC message from container runner', {
          type: (msg as Record<string, unknown>).type,
        });
        return false;
    }
  }

  /** An aborted signal forces `cancelled`; also sets jobFailed. */
  private buildExecutionResult(
    outcome: RunnerOutcome,
    options: JobExecutionOptions,
    startTime: number,
  ): JobExecutionResult {
    let { jobStatus } = outcome;

    if (options.signal.aborted) {
      jobStatus = ExecutionJobStatus.enum.cancelled;
    }

    // Control flow cannot track the async mutation; cast to the full union.
    const finalStatus = jobStatus as 'success' | 'failed' | 'cancelled';
    this.jobFailed = finalStatus !== ExecutionJobStatus.enum.success;

    return {
      status: finalStatus,
      stepResults: outcome.stepResults,
      durationMs: Date.now() - startTime,
      // A cancelled job's runner also exits without job.complete; that is the
      // cancellation, not a crash, so only a failed job carries the crash text.
      ...(finalStatus === ExecutionJobStatus.enum.failed &&
        outcome.error && { error: outcome.error }),
      // The runner-reported reason is carried whatever the status, as in the fork backend.
      ...(outcome.reportedError && { error: outcome.reportedError }),
      ...(outcome.droppedJobs?.length && { droppedJobs: outcome.droppedJobs }),
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
   * Drop the tag a `container.dockerfile` build produced. Best-effort:
   * teardown must not fail a finished job. The layer cache survives.
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
    // Before every early return: the rules are keyed on an IP the bridge will
    // hand to the next job, so leaking them would filter the wrong container.
    await removeJobEgressRules(this.egressRuleIp);
    this.egressRuleIp = undefined;

    // Before the early return: a setup that failed AFTER the build (e.g. the
    // preflight rejecting a musl base) leaves a tag and no container.
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

    // The keepFailed early-return deliberately skips this: a container kept
    // for debugging needs its image too.
    await this.reclaimBuiltImage();

    this.container = null;
  }

  // --- Internal helpers ---

  /**
   * Write the execute message as one JSON line to the exec's stdin; stdin
   * stays open for later relay responses and abort. buildRequest() is shared
   * with fork-runner so the JobDispatch mapping stays consistent.
   */
  private sendExecuteRequest(stream: NodeJS.ReadWriteStream, options: JobExecutionOptions): void {
    const request = buildRequest(options.dispatch, '/workspace');
    const msg: AgentToRunnerMessage = { type: 'execute', request };
    stream.write(JSON.stringify(msg) + '\n');
  }

  /** Write abort to stdin, wait the grace period, then force-stop the container. */
  private async handleAbort(): Promise<void> {
    if (!this.execStream && !this.container) return;

    logger.info('Aborting sandbox execution', { name: this.containerName });

    // Best-effort: the runner honours this in fork mode; in container mode
    // SIGTERM is the primary mechanism.
    if (this.execStream) {
      try {
        const abortMsg: AgentToRunnerMessage = { type: 'abort' };
        this.execStream.write(JSON.stringify(abortMsg) + '\n');
      } catch {
        // Stream may already be closed.
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, ABORT_GRACE_MS));

    if (this.container) {
      try {
        await this.container.stop({ t: 0 });
      } catch {
        // Container may already be stopped.
      }
    }
  }
}
