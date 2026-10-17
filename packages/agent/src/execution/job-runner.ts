import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { makeTempDir } from '@kici-dev/core/tmp';
import Docker from 'dockerode';
import type {
  AgentToOrchestratorMessage,
  JobDispatch,
  JobStatus,
  AgentStepStatus,
  ResolvedSandboxGrant,
} from '@kici-dev/engine';
import {
  ExecutionJobStatus,
  ExecutionStepStatus,
  InitFailureCategory,
  CacheStepType,
  CacheRunEventType,
} from '@kici-dev/engine';
import type { LockJob, LogStream } from '@kici-dev/engine';
import type { AppConfig } from '../config.js';
import { gitClone } from '../checkout/git-clone.js';
import { cloneJobRepos } from '../checkout/clone-job-repos.js';
import { GIT_CREDENTIAL_REQUEST_METHOD } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import { startJobGitCredentials, type JobGitCredentials } from '../checkout/job-git-credentials.js';
import { packKiciSource } from './source-packer.js';
import { boundJobFailureData } from './failure-tail.js';
import { restoreSource } from './source-restore.js';
import type { InitResult } from './init-runner.js';
import { withBootstrapInterception } from '../bootstrap/api-intercept.js';
import { ensureInitRunner } from '../bootstrap/ensure-init-runner.js';
import { LocalDirPayloadSource } from '../bootstrap/payload-source.js';
import {
  S3PayloadSource,
  fetchUrlToFile,
  defaultPayloadCacheDir,
  payloadFileExists,
  type PresignedPayload,
} from '../bootstrap/s3-payload-source.js';
import { MatrixExpansionError } from './dynamic-job-serializer.js';
import { runGlobalEvalRound } from './global-eval-runner.js';
import { runEvalChild } from './sandbox/eval-fork-runner.js';
import { buildCloneRequest } from './sandbox/fork-runner.js';
import type { EvalRequest } from './sandbox/ipc-protocol.js';
import type { GlobalEvalRoundJobConfig } from './global-eval-types.js';
import { jobWorkspaceLayout } from './job-workspace-layout.js';
import { materializeGlobalEvalWorkspace } from './global-eval-workspace.js';
import {
  buildEvalNeedsContext,
  buildEvalShell,
  buildInitFilterInput,
  ensureFilterSourceDir,
} from './eval-context.js';

// Re-exported for callers that import them from the job runner; the eval child
// imports them from `eval-context.ts`.
export { buildEvalNeedsContext, buildEvalShell, buildInitFilterInput, ensureFilterSourceDir };
import { LogStreamer } from './log-streamer.js';
import { CONTAINER_BUILD_STEP_INDEX, runJobImageBuild } from './image-build/build-step.js';
import { buildJobImage, resolveBuildCli, runtimeAddress } from './image-build/build-engine.js';
import {
  resolveContainerRuntime,
  runtimeFactLabels,
  type ContainerRuntimeEndpoint,
} from './image-build/runtime-facts.js';
import { dockerClientFor, requireContainerRuntime } from './container-runtime-preflight.js';
import { applyOverlay } from './overlay-applier.js';
import { installDeps } from './dep-installer.js';
import {
  hostInstallSecrets,
  installKiciDepsOnHost,
  WORKFLOW_LOG_STEP_INDEX,
} from './host-deps-install.js';
import { checkHostInstallEligibility } from './host-install-eligibility.js';
import { checkLockedInstall } from './host-install-lockfile.js';
import {
  resolveHostNpm,
  resolvePinnedPnpm,
  runHostIsolatedInstall,
} from './host-isolated-install.js';
import { redactNpmOutput } from './npm-registry-config.js';
import { PackageManager } from '@kici-dev/shared/package-manager';
import { excludeScratchFromGit } from './dep-restore.js';
import { tryRestoreDeps } from './dep-restore-fallback.js';
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
  ArtifactRequestIpc,
  ArtifactResponseIpc,
  StepApprovalRequestIpc,
  StepApprovalResolvedIpc,
} from './sandbox/index.js';
import {
  BareMetalSandbox,
  ContainerSandbox,
  FirecrackerSandbox,
  buildSanitizedEnv,
  fileCloneSourceBinds,
} from './sandbox/index.js';
import { stepsTotal, stepDurationSeconds, cloneDurationSeconds } from '../metrics/prometheus.js';
import { BetweenJobsController, type AfterJobContext } from './between-jobs-controller.js';

const logger = createLogger({ prefix: 'job-runner' });

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitized base environment for a dependency install in the agent process.
 *
 * `installDeps` defaults `baseEnv` to `process.env`: right in the runner child,
 * wrong here, where the process holds the orchestrator connection and, before
 * boot scrubs them, the agent's own credentials. `buildSanitizedEnv` merges its
 * first argument wholesale at its user-env layer, so it must be `{}`: passing
 * `process.env` re-adds every variable the sanitizer excluded. `trustedEnv` is
 * an operator-set launch property a trusted fleet agent relies on.
 */
function agentInstallBaseEnv(trustedEnv: boolean | undefined): NodeJS.ProcessEnv {
  return buildSanitizedEnv({}, { trustedEnv });
}

/**
 * Everything a dynamic-eval job needs before its workflow module imports: deps,
 * the workflow source, and `.kici/` dependencies. A global workflow's job takes
 * the global layout (`materializeGlobalEvalWorkspace`, shared with init jobs);
 * every other job fills its work dir. `prepareInitWorkspace` is the init job's
 * twin, with its own log wording and Loki-keyed `Init job: checking deps` line.
 */
async function materializeEvalWorkspace(
  dispatch: JobDispatch,
  workDir: string,
  log: (msg: string) => void,
  installOpts: { baseEnv: NodeJS.ProcessEnv; allowInstallScripts: boolean },
): Promise<void> {
  // A global workflow's module lives in the workflow repository, not the source
  // repository the dispatch names.
  // fails-when: a global generator evaluation with no source pack clones only the source repository
  // breaks-if-wrong: a same-repo generator evaluation keeps its single checkout
  if (jobWorkspaceLayout(dispatch.jobConfig, workDir).isGlobal) {
    await materializeGlobalEvalWorkspace({ dispatch, workDir, log, install: installOpts });
    return;
  }

  // Workflow imports such as @kici-dev/sdk need deps; a failed restore leaves
  // `depsRestored` false and the install below runs inline.
  let depsRestored = false;
  if (dispatch.depsUrl) {
    log('Restoring dependencies from cache');
    depsRestored = await tryRestoreDeps({
      workDir,
      depsUrl: dispatch.depsUrl,
      depsHash: dispatch.depsHash,
      log,
    });
  }

  if (dispatch.sourceTarUrl) {
    log('Restoring workflow source from cached tarball');
    await restoreSource(workDir, dispatch.sourceTarUrl, dispatch.sourceTarDigest);
  } else {
    log(`Cloning ${dispatch.repoUrl} ref=${dispatch.ref}`);
    const cloneStart = Date.now();
    await gitClone({
      repoUrl: dispatch.repoUrl,
      ref: dispatch.ref,
      sha: dispatch.sha,
      workDir,
      gitAuth: dispatch.sourceAuth,
    });
    cloneDurationSeconds.record((Date.now() - cloneStart) / 1000);
  }

  // @kici-dev/sdk must resolve under .kici/node_modules/ at import time.
  const kiciDir = join(workDir, '.kici');
  if (!depsRestored && (await fileExists(join(kiciDir, 'package.json')))) {
    log('Installing dependencies locally');
    await installDeps(kiciDir, {
      npmRegistries: dispatch.npmRegistries,
      installEnvSecrets: dispatch.installEnvSecrets,
      jobIdShort: dispatch.jobId.slice(0, 8),
      baseEnv: installOpts.baseEnv,
      allowInstallScripts: installOpts.allowInstallScripts,
    });
  }
}

export interface JobRunnerDeps {
  /** Buffered; replayed on reconnect. */
  send: (msg: AgentToOrchestratorMessage) => void;
  config: AppConfig;
  /**
   * Supervisor-owned between-jobs phase, run after every job to reap the
   * process tree, re-run declared cleanup out-of-band, delete the workdir, and
   * run the operator reset command. Optional so unit harnesses can omit it.
   */
  betweenJobsController?: BetweenJobsController;
  /** A pre-signed S3 upload URL, over WS request-response. */
  requestUploadUrl: (
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      depsHash?: string;
      /** SHA-256 of the source tarball's own bytes; source uploads only. */
      sourceTarDigest?: string;
      /** In-repo sibling closure digest; deps uploads only. */
      siblingsDigest?: string;
      platform: string;
      arch: string;
    },
  ) => Promise<string>;
  /** Lets the orchestrator initialize metadata for a finished S3 upload. */
  sendUploadComplete: (
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      platform: string;
      arch: string;
      depsHash?: string;
      /** SHA-256 of the source tarball's own bytes; source uploads only. */
      sourceTarDigest?: string;
      /** In-repo sibling closure digest; deps uploads only. */
      siblingsDigest?: string;
    },
  ) => void;
  /** Relays the sandbox's ctx.emit() as an event.emit WS message; awaits the response. */
  sendEventEmit: (
    jobId: string,
    requestId: string,
    eventName: string,
    payload: Record<string, unknown>,
    target?: { repos?: string[] },
  ) => Promise<{ requestId: string; deliveryId?: string; error?: string }>;
  /** WS send buffer size in bytes, for LogStreamer backpressure. */
  getBufferedAmount?: () => number;
  /** Register a one-time callback for the WS 'drain' event. */
  onDrain?: (callback: () => void) => void;
  /** A job.context message with execution environment details. */
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
  /** A run.event message for infrastructure lifecycle tracking. */
  sendRunEvent: (
    runId: string,
    eventType: string,
    opts?: {
      jobId?: string;
      metadata?: Record<string, unknown>;
      durationMs?: number;
    },
  ) => void;
  /** Sends job.concurrency.report and resolves with the job.concurrency.ack. */
  sendConcurrencyReport: (
    runId: string,
    jobId: string,
    group: string,
  ) => Promise<{ action: 'proceed' | 'wait' | 'cancel'; reason?: string }>;
  /**
   * Relays the sandbox's kici.* API calls as agent.api.request WS messages.
   * Optional for backward compatibility.
   */
  sendApiRequest?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Maps the sandbox `cache.request` IPC onto `cache.user.restore.request` /
   * `cache.user.save.request` / `cache.user.save.complete`, and the
   * `cache.user.*.response` back onto the IPC shape. Optional for backward
   * compatibility.
   */
  requestUserCache?: (jobId: string, request: CacheRequestIpc) => Promise<CacheResponseIpc>;
  /**
   * Maps the sandbox `provenance.request` IPC onto `provenance.upload.request` /
   * `.complete`. Optional for backward compatibility.
   */
  relayProvenance?: (
    jobId: string,
    request: ProvenanceRequestIpc,
  ) => Promise<ProvenanceResponseIpc>;
  /**
   * Maps the sandbox `artifacts.request` IPC onto `artifacts.upload.request` /
   * `.complete` / `artifacts.download.request`, and the response back onto the
   * IPC shape. Optional for backward compatibility.
   */
  requestUserArtifact?: (
    jobId: string,
    request: ArtifactRequestIpc,
  ) => Promise<ArtifactResponseIpc>;
  /**
   * Maps the sandbox `approval.request` IPC onto `step.approval-request`, and
   * `step.approval-resolved` back onto the IPC shape. Optional for backward
   * compatibility.
   */
  sendStepApproval?: (
    runId: string,
    jobId: string,
    request: StepApprovalRequestIpc,
  ) => Promise<StepApprovalResolvedIpc>;
  /**
   * The container runtime a nested job container starts on, or null when this
   * host has none. Injected for tests; defaults to discovering it on this host.
   */
  resolveContainerRuntime?: () => ContainerRuntimeEndpoint | null;
}

/** Prefix of the workflow-level log line that records a failed job setup. */
const SETUP_FAILED_LOG_PREFIX = '[job-setup] Setup failed:';

interface ActiveJob {
  abortController: AbortController;
  completionPromise: Promise<void>;
  runId: string;
}

/**
 * Mirrors the orchestrator's build-job dispatch payload. A build job installs
 * dependencies, optionally packs deps and source tarballs, and reports status;
 * it runs no workflow steps.
 */
interface BuildJobConfig {
  buildOnly: true;
  contentHash?: string;
  lockfileHash?: string;
  /** In-repo workspace sibling closure digest; part of the dep pointer key. */
  siblingsDigest?: string;
  buildSourceNeeded?: boolean;
  buildDepsNeeded?: boolean;
  workflowName: string;
  resolvedHashFiles?: string[];
}

/**
 * Set by KICI_EXECUTION_MODE or the dispatch's container config:
 * - 'container': a disposable Docker/Podman container (strongest isolation)
 * - 'bare-metal': a child process on the host with env sanitization
 * - 'firecracker': a child process inside a Firecracker VM (defense-in-depth)
 */
type ExecutionMode = 'container' | 'bare-metal' | 'firecracker';

/**
 * The sandbox a standard job created, filled in the moment it exists. The job's
 * teardown reads it, so a sandbox whose setup — or the host-side preparation
 * between its creation and its setup — throws is still torn down, and a tag a
 * Dockerfile build produced is still reclaimed.
 */
interface SandboxSlot {
  sandbox?: ExecutionSandbox;
  executionMode?: ExecutionMode;
}

/**
 * The checkout that carries `.kici/` in a job's work dir: the workflow repo for
 * a global job, the work dir itself otherwise. The runner resolves the same.
 */
function hostWorkflowDir(jobConfig: Record<string, unknown>, workDir: string): string {
  return jobWorkspaceLayout(jobConfig, workDir).workflowDir;
}

/**
 * The runner is a separate rolldown entry point whose location depends on the
 * build mode:
 * - Bundle mode (build-service.mjs): dist/workflow-runner.js (beside server.js)
 * - Library mode (build-ts.mjs): dist/execution/sandbox/workflow-runner.js
 * - Library mode chunked: dist/ with chunks, runner at execution/sandbox/workflow-runner.js
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
 * Probes the same locations as {@link resolveRunnerPath}. The eval child always
 * forks on the agent's host from the agent's build (an evaluation job never uses
 * a sandbox backend), so it needs no self-contained bundle to mount into a job
 * container.
 */
function resolveEvalRunnerPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Bundle mode: __dirname is dist/
  const bundlePath = join(__dirname, 'eval-runner.js');
  if (existsSync(bundlePath)) return bundlePath;
  // Library mode: __dirname is dist/execution/
  const originalPath = join(__dirname, 'sandbox', 'eval-runner.js');
  if (existsSync(originalPath)) return originalPath;
  // Library mode chunked: __dirname is dist/
  const chunkedPath = join(__dirname, 'execution', 'sandbox', 'eval-runner.js');
  if (existsSync(chunkedPath)) return chunkedPath;
  return bundlePath;
}

/**
 * The container backend mounts the runner as a single file, so it runs
 * `workflow-runner-bundle.js` (zx and `@kici-dev/*` inlined): the external
 * `workflow-runner.js` cannot resolve its bare imports without the agent's
 * node_modules / pnpm workspace. build-service.mjs emits the bundle beside the
 * runner. bwrap / firecracker keep the external runner (they bind the workspace).
 */
export function resolveRunnerBundlePath(runnerPath: string): string {
  return join(dirname(runnerPath), 'workflow-runner-bundle.js');
}

/**
 * Priority:
 * 1. config.jobImageAgent -> 'bare-metal'
 * 2. Container config in job dispatch -> 'container'
 * 3. config.executionMode (KICI_EXECUTION_MODE) -> explicit override
 * 4. config.scalerManaged (KICI_SCALER_MANAGED=1) -> 'firecracker'
 * 5. Default -> 'bare-metal'
 */
function determineExecutionMode(
  jobConfig: Record<string, unknown>,
  agentConfig: Pick<AppConfig, 'executionMode' | 'scalerManaged' | 'jobImageAgent'>,
): ExecutionMode {
  // This agent IS the job's image — the scaler spawned it from `container:`
  // with the KiCI runtime injected. Nesting another container from the same
  // image would need a runtime inside a runtime; run the steps right here.
  if (agentConfig.jobImageAgent) {
    return 'bare-metal';
  }

  const containerConfig = jobConfig.container;
  if (containerConfig) {
    return 'container';
  }

  if (agentConfig.executionMode) {
    return agentConfig.executionMode;
  }

  // Firecracker agents run inside VMs managed by the scaler
  if (agentConfig.scalerManaged) {
    return 'firecracker';
  }

  return 'bare-metal';
}

/**
 * - Default: a fresh `mkdtemp` the agent clones into and removes after the job.
 * - **In-place profile** (`inPlace` config + a `file://` source): the source's
 *   real repo path used directly as the workDir, with **no clone** and **no
 *   removal**. The operator runs their own already-built working tree
 *   (module-relative `MONOREPO_ROOT`, `node_modules`, `dist` all present).
 *   Gated to `file://` so a Platform-connected agent (https sources) can never
 *   be pushed onto a tree, and read only from agent config (never a
 *   dispatch/wire value).
 */
export async function resolveJobWorkDir(
  inPlace: boolean,
  repoUrl: string | undefined,
): Promise<{ workDir: string; cleanup: () => Promise<void>; inPlace: boolean }> {
  if (inPlace && repoUrl && repoUrl.startsWith('file://')) {
    return {
      workDir: fileURLToPath(repoUrl),
      // Never remove the operator's real working tree.
      cleanup: async () => {},
      inPlace: true,
    };
  }
  const { path: workDir, cleanup } = await makeTempDir('workdir');
  return {
    workDir,
    cleanup: async () => {
      await cleanup().catch(() => {});
    },
    inPlace: false,
  };
}

/**
 * Runs each `job.dispatch`: creates the work directory, selects the sandbox
 * backend, delegates clone/compile/steps to it, wires its IPC to the WS
 * pipeline, reports status, and cleans up.
 *
 * Customer code runs in an isolated child process, never in the agent's V8
 * isolate. Build jobs run in-process: they execute no customer workflow steps.
 */
export class JobRunner {
  private readonly send: (msg: AgentToOrchestratorMessage) => void;
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
  /** Live git credentials per job, so the sandbox can reach the grant table. */
  private readonly jobGitCredentials = new Map<string, JobGitCredentials>();
  private readonly _requestUserCache?: JobRunnerDeps['requestUserCache'];
  private readonly _relayProvenance?: JobRunnerDeps['relayProvenance'];
  private readonly _requestUserArtifact?: JobRunnerDeps['requestUserArtifact'];
  private readonly _sendStepApproval?: JobRunnerDeps['sendStepApproval'];
  private readonly resolveContainerRuntime: () => ContainerRuntimeEndpoint | null;

  /** For concurrency and cancellation. */
  readonly activeJobs = new Map<string, ActiveJob>();

  /** Used for abort. */
  private activeSandbox: ExecutionSandbox | null = null;

  private readonly betweenJobsController?: BetweenJobsController;

  /**
   * Facts about the just-finished standard job, captured before sandbox
   * teardown so the between-jobs controller (run in `execute`'s `.finally`) can
   * reach them. Null for special job types (init / build / dynamic), which run
   * no sandbox — the controller then only deletes the workdir and resets.
   */
  private betweenJobsFacts: {
    completionHooksRan: boolean;
    declaresCleanup: boolean;
    backend: ExecutionMode;
    jobFailed: boolean;
    reap: () => Promise<number>;
    cleanupSpawn?: (workDir: string, signal: AbortSignal) => Promise<void>;
  } | null = null;

  constructor(deps: JobRunnerDeps) {
    this.send = deps.send;
    this.config = deps.config;
    this.betweenJobsController = deps.betweenJobsController;
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
    this._requestUserArtifact = deps.requestUserArtifact;
    this._sendStepApproval = deps.sendStepApproval;
    this.resolveContainerRuntime =
      deps.resolveContainerRuntime ?? (() => resolveContainerRuntime());
  }

  async execute(dispatch: JobDispatch): Promise<void> {
    const { runId: _runId, jobId, jobConfig: _jobConfig } = dispatch;
    const abortController = new AbortController();

    const { workDir, cleanup, inPlace } = await resolveJobWorkDir(
      this.config.inPlace,
      dispatch.repoUrl,
    );
    // In-place skips the clone. `checkout` here is config-derived, never a
    // wire/jobConfig value a workflow could set.
    if (inPlace) {
      (dispatch.jobConfig as Record<string, unknown>).checkout = false;
    }

    this.betweenJobsFacts = null;

    // The helper socket git talks to and the grant table `withWrite` elevates.
    // Started before the job so every clone uses the helper; closed in the same
    // `finally` as the workdir so a failed job cannot leak the socket.
    const gitCredentials = await this.startGitCredentials(
      jobId,
      dispatch.jobConfig as Record<string, unknown>,
    );

    const completionPromise = this.runJob(dispatch, workDir, abortController).finally(async () => {
      const facts = this.betweenJobsFacts;
      this.activeJobs.delete(jobId);
      this.activeSandbox = null;
      this.betweenJobsFacts = null;
      this.jobGitCredentials.delete(jobId);
      await gitCredentials?.close().catch(() => {
        /* best effort — the socket lives in the job dir, reaped with it */
      });

      // Owns the workdir deletion so the out-of-band cleanup re-run can use the
      // preserved dir first. A throw here must never break the supervisor loop:
      // the job is already reported.
      await this.runBetweenJobsPhase(facts, workDir, cleanup);
    });

    this.activeJobs.set(jobId, { abortController, completionPromise, runId: dispatch.runId });

    return completionPromise;
  }

  /**
   * `undefined` when the agent has no orchestrator relay (unit harnesses,
   * offline local runs).
   *
   * A failure here must not fail the job: without a helper, git falls back to
   * its own mechanisms and the job cannot push.
   */
  private async startGitCredentials(
    jobId: string,
    jobConfig: Record<string, unknown>,
  ): Promise<JobGitCredentials | undefined> {
    if (!this._sendApiRequest) return undefined;
    try {
      const { path: dir } = await makeTempDir(`gitcred-${jobId}`);
      const credentials = await startJobGitCredentials({
        jobId,
        dir,
        sendApiRequest: this._sendApiRequest,
        // The job's `gitCredentials`, carried from the lock through `jobConfig`.
        // Values are secret names: the agent resolves nothing, and the
        // orchestrator checks each ref against the declaration it persisted on
        // the job row before resolving it.
        credentials: jobConfig.gitCredentials as
          Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
      });
      this.jobGitCredentials.set(jobId, credentials);
      return credentials;
    } catch (err) {
      logger.warn('Could not start git credentials for job; git push will not work', {
        jobId,
        error: toErrorMessage(err),
      });
      return undefined;
    }
  }
  /**
   * Delegates to the `BetweenJobsController` (out-of-band cleanup → reap →
   * workdir delete → operator reset) with facts captured before sandbox
   * teardown. With no controller (unit harnesses) it only deletes the workdir.
   * Never throws.
   */
  private async runBetweenJobsPhase(
    facts: JobRunner['betweenJobsFacts'],
    workDir: string,
    deleteWorkdir: () => Promise<void>,
  ): Promise<void> {
    if (!this.betweenJobsController) {
      await deleteWorkdir().catch((err) =>
        logger.warn('Work directory cleanup error', { error: toErrorMessage(err) }),
      );
      return;
    }

    // Facts are absent for special job types (init / build / dynamic): they run
    // no sandbox, so there is nothing to reap or re-run — only delete + reset.
    const ctx: AfterJobContext = {
      completionHooksRan: facts?.completionHooksRan ?? true,
      jobFailed: facts?.jobFailed ?? false,
      backend: facts?.backend ?? 'bare-metal',
      declaresCleanup: facts?.declaresCleanup ?? false,
      workDir,
      reap: facts?.reap ?? (() => Promise.resolve(0)),
      deleteWorkdir,
      ...(facts?.cleanupSpawn ? { cleanupSpawn: facts.cleanupSpawn } : {}),
    };

    try {
      await this.betweenJobsController.afterJob(ctx);
    } catch (err) {
      logger.error('Between-jobs phase error', { error: toErrorMessage(err) });
      // A controller that threw early may have left the workdir; a reused agent
      // must not accumulate them.
      await deleteWorkdir().catch(() => {});
    }
  }

  /**
   * Signals the job's abort controller and aborts the active sandbox. `_force`
   * is ignored: no path here force-cancels.
   */
  cancel(jobId: string, reason: string, _force: boolean = false): void {
    const active = this.activeJobs.get(jobId);
    if (!active) return;

    active.abortController.abort(reason);

    if (this.activeSandbox) {
      this.activeSandbox.abort().catch(() => {});
    }
  }

  /** Special job types (init / dynamicJobFn / build) short-circuit the sandbox pipeline. */
  private async runJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    if (await this.dispatchSpecialJobType(dispatch, workDir, abortController)) {
      return;
    }

    await this.executeStandardJob(dispatch, workDir, abortController);
  }

  /** `true` when a special handler ran and the caller must return; `false` for a standard job. */
  private async dispatchSpecialJobType(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<boolean> {
    const { runId, jobId, jobConfig } = dispatch;

    // Init-only jobs resolve dynamic fields.
    const isInitOnly = (jobConfig as { initOnly?: boolean }).initOnly === true;
    if (isInitOnly) {
      await this.handleInitJob(dispatch, workDir, abortController);
      return true;
    }

    // The pre-run global eval round: filters and generators for every candidate
    // global workflow of one workflow repo, on one dual checkout.
    const isGlobalEvalRound = (jobConfig as { globalEvalRound?: boolean }).globalEvalRound === true;
    if (isGlobalEvalRound) {
      await this.handleGlobalEvalRound(dispatch, workDir, abortController);
      return true;
    }

    const isDynamicJobFnEval = (jobConfig as { dynamicJobFn?: boolean }).dynamicJobFn === true;
    if (isDynamicJobFnEval) {
      await this.handleDynamicJobFn(dispatch, workDir, abortController);
      return true;
    }

    const isBringupOnly = (jobConfig as { bringupOnly?: boolean }).bringupOnly === true;
    if (isBringupOnly) {
      await this.handleBringupJob(dispatch);
      return true;
    }

    const isBuildOnly = (jobConfig as { buildOnly?: boolean }).buildOnly === true;
    if (isBuildOnly) {
      // A fullRepo run never dispatches a build job; guard anyway.
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

  /** An execution error reports a failed job; the sandbox is always torn down. */
  private async executeStandardJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId } = dispatch;

    // The trace header, once per job.
    const ctx = getRequestContext();
    logger.info(`Run: ${ctx.runId ?? runId} | Trace: ${ctx.requestId ?? 'N/A'}`);

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    // Lets the orchestrator detect stale runs.
    const heartbeatTimer = setInterval(() => {
      this.send({
        type: 'job.heartbeat',
        runId,
        jobId,
        timestamp: Date.now(),
      });
    }, this.config.jobHeartbeatIntervalMs);

    // `slot` records the sandbox as soon as it exists. jobFailed defaults to
    // true: an agent-side throw before a result is a failure, and a job that
    // leaked a daemon and then threw is exactly what the reap targets.
    const slot: SandboxSlot = {};
    let jobFailed = true;

    // Owned here, not in runSandboxExecution, so an execution that throws still
    // flushes the failing step's buffered tail, where the diagnostics sit. A
    // container job's host-side setup lines land here too, under step -1.
    const logStreamers = new Map<number, LogStreamer>();
    // An error before setup finishes is a setup failure, recorded in the
    // workflow-level log beside its setup lines.
    let setupFinished = false;

    try {
      const setupResult = await this.setupSandboxForExecution(dispatch, workDir, abortController, {
        logStreamers,
        slot,
      });
      if (!setupResult) {
        // Aborted during setup; the cancellation status is already sent.
        return;
      }
      setupFinished = true;
      const { sandbox } = setupResult;

      const result = await this.runSandboxExecution(
        dispatch,
        sandbox,
        abortController,
        logStreamers,
      );
      jobFailed = result.status !== ExecutionJobStatus.enum.success;

      this.reportExecutionResult(dispatch, result, logStreamers);
    } catch (error) {
      // Redacted like the host-side setup lines: a setup error can echo a
      // registry token or an install secret.
      const errorMsg = redactNpmOutput(toErrorMessage(error), hostInstallSecrets(dispatch));
      // A setup failure ends the job before any step runs, so the
      // workflow-level log is the only log it has.
      if (!setupFinished) {
        this.getOrCreateStreamer(dispatch, logStreamers, WORKFLOW_LOG_STEP_INDEX).addLine(
          `${SETUP_FAILED_LOG_PREFIX} ${errorMsg}`,
        );
      }
      // Flush before the terminal status. destroy() is idempotent: a job that
      // went through reportExecutionResult re-enters here with empty buffers.
      for (const streamer of logStreamers.values()) {
        streamer.destroy();
      }
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, {
        error: errorMsg,
      });
    } finally {
      clearInterval(heartbeatTimer);
      const jobSandbox = slot.sandbox;
      if (jobSandbox) {
        // Captured before teardown, on the throw path too, so a job that leaked
        // a daemon and then threw is still reaped. completionHooksRan /
        // declaresCleanup read the still-live runner handle.
        this.betweenJobsFacts = {
          completionHooksRan: jobSandbox.completionHooksRan ?? true,
          declaresCleanup: jobSandbox.declaresCleanup ?? false,
          backend: slot.executionMode ?? 'bare-metal',
          jobFailed,
          reap: () => jobSandbox.reap?.() ?? Promise.resolve(0),
          ...(jobSandbox.runCleanupOnly
            ? {
                cleanupSpawn: (wd: string, sig: AbortSignal) => jobSandbox.runCleanupOnly!(wd, sig),
              }
            : {}),
        };
        // Kills the runner child; the process group survives for the reap.
        this.emitRunEvent(runId, 'agent.teardown', { jobId });
        await jobSandbox.teardown().catch((err) => {
          logger.warn('Sandbox teardown error', {
            error: toErrorMessage(err),
          });
        });
      }
    }
  }

  /**
   * Returns `null` when the abort signal fires before or during setup; the
   * `cancelled` status is then already sent.
   *
   * `io.slot` receives the sandbox the moment it exists, so the caller tears it
   * down even when a later setup step throws. A container job's host-side setup
   * writes to the step -1 streamer in `io.logStreamers`, which the runner's own
   * step -1 lines reuse.
   */
  private async setupSandboxForExecution(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
    io: { logStreamers: Map<number, LogStreamer>; slot: SandboxSlot },
  ): Promise<{
    sandbox: ExecutionSandbox;
    sanitizedEnv: Record<string, string>;
    executionMode: ExecutionMode;
  } | null> {
    const { runId, jobId, jobConfig } = dispatch;

    if (abortController.signal.aborted) {
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
      return null;
    }

    const executionMode = determineExecutionMode(jobConfig as Record<string, unknown>, {
      executionMode: this.config.executionMode,
      scalerManaged: this.config.scalerManaged,
      jobImageAgent: this.config.jobImageAgent,
    });
    const runnerPath = resolveRunnerPath();
    // Secrets are NOT injected into env vars -- they flow through IPC to ctx.secrets.
    const typedConfig = jobConfig as Record<string, unknown>;
    const sanitizedEnv = buildSanitizedEnv((typedConfig.env as Record<string, string>) ?? {}, {
      contextVars: (typedConfig.contextVars as Record<string, string>) ?? undefined,
      jobEnv: (typedConfig.jobEnv as Record<string, string>) ?? undefined,
      // Read only from agent config, never the dispatch, so a workflow cannot
      // self-elevate.
      trustedEnv: this.config.trustedEnv,
    });

    // Resolved before the clone, so a host without a container runtime fails at
    // once with a message naming it, not on a bare ENOENT later.
    const containerRuntime =
      executionMode === 'container'
        ? requireContainerRuntime({
            container: typedConfig.container,
            agentLabels: [...this.config.labels, ...runtimeFactLabels()],
            resolve: this.resolveContainerRuntime,
          })
        : undefined;

    // A container job clones on the host, not in the customer's image: the
    // image needs no git, and clone-time credentials stay with the host's
    // credential helper. A route into the `CapDrop: ALL` container would hand
    // anything in /workspace a direct line to the credential broker. The runner
    // is told the checkout is done, so it does not re-clone over the copied tree.
    const hostCheckout =
      executionMode === 'container' && (jobConfig as Record<string, unknown>).checkout !== false;
    // Redacts the dispatch's registry tokens and install secrets.
    const secrets = hostInstallSecrets(dispatch);
    const setupLog = (line: string): void => {
      this.getOrCreateStreamer(dispatch, io.logStreamers, WORKFLOW_LOG_STEP_INDEX).addLine(
        redactNpmOutput(line, secrets),
      );
    };
    if (hostCheckout) {
      await this.checkoutOnHost(dispatch, workDir, setupLog);
    }

    // A declared Dockerfile builds after the clone, whose tree is the build
    // context, and before the sandbox, which runs the built tag.
    const builtImage = await this.buildJobImageIfDeclared(
      dispatch,
      jobConfig as Record<string, unknown>,
      workDir,
      abortController,
      containerRuntime,
    );

    logger.info('Creating execution sandbox', { executionMode, jobId, runnerPath });

    const sandbox = this.createSandbox(executionMode, {
      runnerPath,
      env: sanitizedEnv,
      jobId,
      jobConfig: jobConfig as Record<string, unknown>,
      registryAuth: dispatch.containerRegistryAuth,
      ...(builtImage ? { builtImage } : {}),
      ...(containerRuntime ? { containerRuntime } : {}),
    });

    this.activeSandbox = sandbox;
    io.slot.sandbox = sandbox;
    io.slot.executionMode = executionMode;

    // `.kici/` deps install into the host checkout, so the copied tree carries
    // them: after the image build, so its context never holds
    // `.kici/node_modules`, and before the setup, which copies the workspace in.
    if (hostCheckout) {
      try {
        await this.installDepsOnHost(dispatch, workDir, setupLog, abortController.signal);
      } catch (err) {
        // A cancel kills the install; that is a cancellation, not a failure.
        if (!abortController.signal.aborted) throw err;
      }
    }
    // fails-when: a job cancelled during the host install still creates,
    // starts and fills its container before the post-setup abort check.
    if (abortController.signal.aborted) {
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
      return null;
    }

    // Container: create + start; bare-metal: validate. The file:// clone-source
    // binds let a container job read a local source (bare-metal derives its own
    // and ignores them); empty for https/ssh remotes.
    await sandbox.setup({
      workDir,
      env: sanitizedEnv,
      extraReadOnlyBinds: fileCloneSourceBinds(dispatch.repoUrl),
      ...(hostCheckout ? { workspaceFromHost: true } : {}),
    });

    if (abortController.signal.aborted) {
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
      return null;
    }

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

    return { sandbox, sanitizedEnv, executionMode };
  }

  /**
   * Wires the sandbox IPC callbacks to the WS pipeline. `logStreamers` fills
   * lazily per step and is owned by the caller, so a throw leaves it flushable.
   */
  private async runSandboxExecution(
    dispatch: JobDispatch,
    sandbox: ExecutionSandbox,
    abortController: AbortController,
    logStreamers: Map<number, LogStreamer>,
  ): Promise<JobExecutionResult> {
    const { runId, jobId } = dispatch;

    const executionStartMs = Date.now();
    this.emitRunEvent(runId, 'agent.execution.start', { jobId });

    const result: JobExecutionResult = await sandbox.executeJob({
      dispatch,
      onStepStatus: (stepIndex, stepName, state, data) => {
        // A terminal step forwards its raw byte total, which the orchestrator
        // sums into execution_jobs.log_bytes / execution_runs.log_bytes.
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
        // `run.event`, as hooks do, so the run timeline records its outcome.
        this.maybeEmitCacheRunEvent(runId, jobId, stepIndex, state, data);
        this.sendStepStatus(dispatch, stepIndex, stepName, state, data, logBytesStreamed);
      },
      onLogLine: (stepIndex, line, stream) => {
        const streamer = this.getOrCreateStreamer(dispatch, logStreamers, stepIndex);
        streamer.addLine(line, stream);
      },
      signal: abortController.signal,
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
      onConcurrencyReport: async (report) => {
        const ack = await this._sendConcurrencyReport(dispatch.runId, dispatch.jobId, report.group);
        return {
          type: 'concurrency.ack' as const,
          action: ack.action,
          reason: ack.reason,
        };
      },
      onApiRequest: this._sendApiRequest
        ? withBootstrapInterception(async (method, params) => {
            // `ctx.kici.git.github.getToken()` bypasses the credential helper,
            // so its request carries no ref; attach the job's declared one.
            const patched =
              method === GIT_CREDENTIAL_REQUEST_METHOD
                ? (this.jobGitCredentials.get(jobId)?.withRef(params ?? {}) ?? params)
                : params;
            return this._sendApiRequest!(method, patched);
          })
        : undefined,
      // The git write-grant relay ends at the agent's grant table, not the
      // orchestrator: the credential helper git spawns consults the agent.
      onGitGrantRequest: this.jobGitCredentials.get(jobId)?.onGitGrantRequest,
      credentialHelperPath: this.jobGitCredentials.get(jobId)?.helperPath,
      allowInstallScripts: this.config.allowInstallScripts,
      onCacheRequest: this._requestUserCache
        ? async (request) => this._requestUserCache!(jobId, request)
        : undefined,
      onProvenanceRequest: this._relayProvenance
        ? async (request) => this._relayProvenance!(jobId, request)
        : undefined,
      onArtifactRequest: this._requestUserArtifact
        ? async (request) => this._requestUserArtifact!(jobId, request)
        : undefined,
      onApprovalRequest: this._sendStepApproval
        ? async (request) => this._sendStepApproval!(dispatch.runId, dispatch.jobId, request)
        : undefined,
      // Secret-mount audit events; the orchestrator persists them beside
      // `secretsAccessed` (execution-tracker.ts, onStepStatusForward).
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

    this.emitRunEvent(runId, 'agent.execution.end', {
      jobId,
      durationMs: Date.now() - executionStartMs,
      metadata: { status: result.status },
    });

    return result;
  }

  /** Flushes the streamers, records step metrics and sends the terminal `job.status`. */
  private reportExecutionResult(
    dispatch: JobDispatch,
    result: JobExecutionResult,
    logStreamers: Map<number, LogStreamer>,
  ): void {
    // Before the final status: destroy() force-sends the remaining buffer,
    // bypassing backpressure.
    for (const streamer of logStreamers.values()) {
      streamer.destroy();
    }

    for (const stepResult of result.stepResults) {
      stepsTotal.add(1, { status: stepResult.status });
      if (stepResult.durationMs > 0) {
        stepDurationSeconds.record(stepResult.durationMs / 1000);
      }
    }

    // Makes a remote-agent failure diagnosable from the agent log alone. An
    // init-phase failure has no step results, so result.error is its only cause.
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

    this.sendJobStatus(
      dispatch,
      result.status,
      {
        durationMs: result.durationMs,
        ...(result.error && { error: result.error }),
        ...(result.outputs && { outputs: result.outputs }),
        // For drift reporting.
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
   * Brings up a temporary init-runner over SSH on a declared host with no agent
   * (fresh-box bootstrap). The orchestrator dispatches this synthetic
   * `__bringup__` job to an agent with `kici:capability:ssh-transport`. The
   * privileged resolve is relayed to the orchestrator; the SSH transport runs in
   * this agent process and never reaches workflow code. No clone, no sandbox:
   * the init-runner connects under the target's agent id, and the
   * orchestrator's pinned-hold drains the target's bootstrap steps onto it.
   */
  private async handleBringupJob(dispatch: JobDispatch): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;
    const targetAgentId = String((jobConfig as { bringupTarget?: string }).bringupTarget ?? '');

    logger.info('Starting bring-up job', { jobId, runId, targetAgentId });
    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);
    const streamer = this.createStepStreamer(dispatch, 0);
    this.sendStepStatus(dispatch, 0, 'bring-up', ExecutionStepStatus.enum.running);

    try {
      if (!targetAgentId) throw new Error('bring-up job missing bringupTarget');
      if (!this._sendApiRequest) {
        throw new Error('bring-up job requires an orchestrator API transport');
      }
      streamer.addLine(`Bringing up init-runner on ${targetAgentId}…`);
      // This agent performs the SSH transport itself (`ensureInitRunner` relays
      // the privileged resolve to the orchestrator), over the raw orchestrator
      // transport, never `withBootstrapInterception`, which catches the method
      // coming from a workflow sandbox.
      // A self-contained agent+Node payload lets a Node-less stock rescue box
      // boot on its vendored Node. Its primary source is the orchestrator's
      // cache bucket (a presigned URL over `kici.presignAgentPackage`);
      // KICI_AGENT_PAYLOAD_DIR selects the air-gap local dir, and
      // KICI_AGENT_COMMAND (golden image) skips the payload copy.
      const transport = async (method: string, params: Record<string, unknown>) =>
        this._sendApiRequest!(method, params);
      const payloadSource = this.config.agentPayloadDir
        ? new LocalDirPayloadSource(this.config.agentPayloadDir)
        : new S3PayloadSource({
            presign: async (platform) =>
              (await transport('kici.presignAgentPackage', {
                targetAgentId,
                platform,
              })) as PresignedPayload | null,
            fetchToFile: fetchUrlToFile,
            cacheDir: defaultPayloadCacheDir(),
            exists: payloadFileExists,
          });
      const result = await ensureInitRunner(transport, targetAgentId, {
        payloadSource,
        agentCommand: this.config.agentCommand,
      });
      streamer.addLine(
        result.broughtUp
          ? `Init-runner brought up on ${targetAgentId}.`
          : `${targetAgentId} already has a live agent — no bring-up needed.`,
      );
      await streamer.flush();
      this.sendStepStatus(
        dispatch,
        0,
        'bring-up',
        ExecutionStepStatus.enum.success,
        undefined,
        streamer.getTotalBytes(),
      );
      streamer.destroy();
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      streamer.addLine(`Bring-up failed: ${message}`);
      await streamer.flush();
      this.sendStepStatus(
        dispatch,
        0,
        'bring-up',
        ExecutionStepStatus.enum.failed,
        undefined,
        streamer.getTotalBytes(),
      );
      streamer.destroy();
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, { error: message });
      logger.warn('Bring-up job failed', { jobId, runId, targetAgentId, error: message });
    }
  }

  private async handleBuildJob(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;

    // The trace header, once per job.
    const buildCtx = getRequestContext();
    logger.info(`Run: ${buildCtx.runId ?? runId} | Trace: ${buildCtx.requestId ?? 'N/A'}`);

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    const buildStreamer = this.createStepStreamer(dispatch, 0);
    const buildLog = (msg: string) => buildStreamer.addLine(msg);

    // A synthetic step, so the orchestrator creates an execution_steps row.
    this.sendStepStatus(dispatch, 0, 'build', ExecutionStepStatus.enum.running);

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

    // Lets the orchestrator detect stale runs.
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

      await this.packAndUploadSource(
        dispatch,
        workDir,
        buildConfig,
        buildStreamer,
        buildLog,
        abortController.signal,
      );

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

  /** A test run with uncommitted changes carries an overlay tarball. */
  private async cloneAndApplyOverlay(
    dispatch: JobDispatch,
    workDir: string,
    buildLog: (msg: string) => void,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;

    buildLog(`Cloning ${dispatch.repoUrl} (ref: ${dispatch.ref})`);
    const cloneStart = Date.now();
    this.emitRunEvent(runId, 'agent.clone.start', { jobId });
    await gitClone({
      repoUrl: dispatch.repoUrl,
      ref: dispatch.ref,
      sha: dispatch.sha,
      workDir,
      gitAuth: dispatch.sourceAuth,
    });
    const cloneDurationMs = Date.now() - cloneStart;
    cloneDurationSeconds.record(cloneDurationMs / 1000);
    this.emitRunEvent(runId, 'agent.clone.end', { jobId, durationMs: cloneDurationMs });
    buildLog(`Clone completed in ${cloneDurationMs}ms`);

    const tarballUrl = (jobConfig as Record<string, unknown>).tarballUrl as string | undefined;
    const cliPublicKey = (jobConfig as Record<string, unknown>).cliPublicKey as string | undefined;
    const orchestratorPrivateKey = (jobConfig as Record<string, unknown>).orchestratorPrivateKey as
      string | undefined;

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
   * A `fullRepo` test run ships its working tree as an encrypted overlay
   * tarball, not a git repo, so it skips the clone, as the execution-job path
   * does. Otherwise: the cached tarball if present, else a clone. An attached
   * overlay applies afterward in every case; for a fullRepo run it is what
   * populates the workspace, so the init job resolves against the real tree.
   */
  private async materializeInitJobSource(
    dispatch: JobDispatch,
    workDir: string,
    initLog: (msg: string) => void,
  ): Promise<void> {
    const initJobConfig = dispatch.jobConfig as { fullRepo?: boolean };
    if (initJobConfig.fullRepo) {
      initLog('Test run: materializing workspace from overlay (no clone)');
      await fs.mkdir(workDir, { recursive: true });
    } else if (dispatch.sourceTarUrl) {
      initLog('Restoring workflow source from cached tarball');
      await restoreSource(workDir, dispatch.sourceTarUrl, dispatch.sourceTarDigest);
    } else {
      initLog(`Cloning ${dispatch.repoUrl} (ref: ${dispatch.ref})`);
      const cloneStart = Date.now();
      await gitClone({
        repoUrl: dispatch.repoUrl,
        ref: dispatch.ref,
        sha: dispatch.sha,
        workDir,
        gitAuth: dispatch.sourceAuth,
      });
      cloneDurationSeconds.record((Date.now() - cloneStart) / 1000);
    }

    await this.applyInitJobOverlay(dispatch, workDir, initLog);
  }

  /** Applies to the checkout that holds `.kici/`. */
  private async applyInitJobOverlay(
    dispatch: JobDispatch,
    repoDir: string,
    initLog: (msg: string) => void,
  ): Promise<void> {
    const initJobConfig = dispatch.jobConfig as {
      tarballUrl?: string;
      cliPublicKey?: string;
      orchestratorPrivateKey?: string;
    };
    if (
      !initJobConfig.tarballUrl ||
      !initJobConfig.cliPublicKey ||
      !initJobConfig.orchestratorPrivateKey
    ) {
      return;
    }
    initLog('Applying overlay tarball for test run');
    const overlayResult = await applyOverlay({
      tarballUrl: initJobConfig.tarballUrl,
      cliPublicKey: initJobConfig.cliPublicKey,
      orchestratorPrivateKey: initJobConfig.orchestratorPrivateKey,
      repoDir,
    });
    logger.info('Init job: overlay applied', {
      jobId: dispatch.jobId,
      filesApplied: overlayResult.filesApplied,
      filesDeleted: overlayResult.filesDeleted,
    });
  }

  /**
   * Puts the workflow source and its `.kici/` dependencies on disk. A global
   * workflow's init job takes the global layout (`workflow/` and `source/`);
   * any other init job fills its work dir.
   */
  private async prepareInitWorkspace(
    dispatch: JobDispatch,
    workDir: string,
    initLog: (msg: string) => void,
    source: string,
  ): Promise<void> {
    const install = {
      baseEnv: agentInstallBaseEnv(this.config.trustedEnv),
      allowInstallScripts: this.config.allowInstallScripts,
    };
    // fails-when: a global init job with no source pack clones only the source repository
    // breaks-if-wrong: a same-repo init job keeps its single checkout
    if (jobWorkspaceLayout(dispatch.jobConfig, workDir).isGlobal) {
      await materializeGlobalEvalWorkspace({
        dispatch,
        workDir,
        log: initLog,
        install,
        afterClone: (workflowDir) => this.applyInitJobOverlay(dispatch, workflowDir, initLog),
        onDepsCheck: (kiciDir, hasPackageJson) =>
          logger.info('Init job: checking deps', { kiciDir, hasPackageJson, source }),
      });
      return;
    }

    // Workflow imports such as @kici-dev/sdk need deps; a failed restore leaves
    // `depsRestored` false and the install below runs inline.
    let depsRestored = false;
    if (dispatch.depsUrl) {
      initLog('Restoring dependencies from cache');
      depsRestored = await tryRestoreDeps({
        workDir,
        depsUrl: dispatch.depsUrl,
        depsHash: dispatch.depsHash,
        log: initLog,
      });
    }

    await this.materializeInitJobSource(dispatch, workDir, initLog);

    // @kici-dev/sdk must resolve under .kici/node_modules/ at import time.
    const kiciDir = join(workDir, '.kici');
    const hasPackage = await fileExists(join(kiciDir, 'package.json'));
    logger.info('Init job: checking deps', {
      kiciDir,
      hasPackageJson: hasPackage,
      source,
    });
    if (!depsRestored && hasPackage) {
      initLog('Installing dependencies locally');
      await installDeps(kiciDir, {
        npmRegistries: dispatch.npmRegistries,
        installEnvSecrets: dispatch.installEnvSecrets,
        jobIdShort: dispatch.jobId.slice(0, 8),
        ...install,
      });
    }
  }

  /**
   * Installs dependencies when the build needs them and, when the orchestrator
   * flagged the dep cache as stale, packs and uploads `.kici/node_modules/`.
   */
  private async packAndUploadDeps(
    dispatch: JobDispatch,
    kiciDir: string,
    buildConfig: BuildJobConfig,
    buildLog: (msg: string) => void,
  ): Promise<void> {
    // The source pack needs deps installed locally too.
    const needDepsLocally = buildConfig.buildDepsNeeded || buildConfig.buildSourceNeeded;
    if (!needDepsLocally) return;

    const hasPackageJson = await fileExists(join(kiciDir, 'package.json'));
    if (!hasPackageJson) return;

    buildLog('Installing dependencies...');
    await installDeps(kiciDir, {
      npmRegistries: dispatch.npmRegistries,
      installEnvSecrets: dispatch.installEnvSecrets,
      jobIdShort: dispatch.jobId.slice(0, 8),
      baseEnv: agentInstallBaseEnv(this.config.trustedEnv),
      allowInstallScripts: this.config.allowInstallScripts,
    });
    buildLog('Dependencies installed');

    if (!buildConfig.buildDepsNeeded) return;

    const { tarball, hash } = await packNodeModules(kiciDir);

    const depKey = {
      lockfileHash: buildConfig.lockfileHash!,
      // Echoed back so the pointer lands under the key the orchestrator's probe
      // reads. A sibling edit moves no lock file, so without it the pointer
      // would name a stale sibling build.
      ...(buildConfig.siblingsDigest && { siblingsDigest: buildConfig.siblingsDigest }),
      platform: os.platform(),
      arch: os.arch(),
    };
    logger.info('Requesting dep upload URL from orchestrator', {
      lockfileHash: buildConfig.lockfileHash,
    });
    // The hash goes with the request, not just the completion: the object is
    // stored under it, so the orchestrator needs it to sign the URL.
    const depUploadUrl = await this.requestUploadUrl(dispatch.jobId, 'deps', {
      ...depKey,
      depsHash: hash,
    });
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

  /** Verifies the clone against the lock file's `contentHash`, then packs and uploads `.kici/`. */
  private async packAndUploadSource(
    dispatch: JobDispatch,
    workDir: string,
    buildConfig: BuildJobConfig,
    buildStreamer: LogStreamer,
    buildLog: (msg: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (!buildConfig.buildSourceNeeded || !buildConfig.contentHash) return;

    const sourceFile = (dispatch.jobConfig as { source?: { file: string } }).source?.file;
    if (!sourceFile) return;

    buildLog(`Verifying workflow source (${sourceFile})...`);
    // Catches drift where the orchestrator saw a different source revision than
    // the agent cloned. The check is a module import, and module top-level is
    // customer code, so it runs in the eval child; its console output lands on
    // this build step's log.
    await this.runEvaluation({
      kind: 'build-verify',
      dispatch,
      workDir,
      config: {
        sourceFile,
        contentHash: buildConfig.contentHash,
        resolvedHashFiles: buildConfig.resolvedHashFiles,
      },
      emit: (line) => buildStreamer.addLine(line),
      signal,
    });

    buildLog('Packing .kici/ source tarball...');
    const { tarball, hash: sourceTarDigest } = await packKiciSource(workDir);

    // The tarball's own digest: the orchestrator stores the object under it
    // and the restoring agent verifies against it, as with `depsHash`.
    const sourceKey = {
      contentHash: buildConfig.contentHash,
      sourceTarDigest,
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
      sourceTarDigest,
    });
  }

  /**
   * Runs once per (event × workflow repo), before any run row exists: checks
   * out both repos and runs each candidate global workflow's `filter` and, for
   * a survivor, its `DynamicJobFn`s, so the orchestrator learns which workflows
   * apply and which jobs each generates.
   *
   * A failed candidate is reported indeterminate in the result, not as a job
   * failure: one broken filter must not suppress unrelated org-wide workflows.
   * The job fails only when the checkout or the round machinery breaks.
   */
  private async handleGlobalEvalRound(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;
    const config = jobConfig as unknown as GlobalEvalRoundJobConfig;

    logger.info('Starting global eval round', {
      jobId,
      // Defensive: this runs before the `try`, whose guard reports a malformed
      // `candidates` as a failure.
      candidateCount: Array.isArray(config.candidates) ? config.candidates.length : 0,
      workflowRepoIdentifier: config.workflowRepoIdentifier,
    });
    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    const evalStreamer = this.createStepStreamer(dispatch, 0);
    // The round's deadline cannot preempt a candidate mid-`await`, so a late
    // `console.log` can arrive after the streamer is destroyed. Drop it rather
    // than emit a `log.append` for a step already terminal.
    let streamerClosed = false;
    const evalLog = (msg: string) => {
      if (!streamerClosed) evalStreamer.addLine(msg);
    };
    // The zx shell writes to the streamer directly and needs the same guard: an
    // orphaned candidate usually outlives its budget waiting on a subprocess.
    const evalStreamLine = (line: string, stream: LogStream) => {
      if (!streamerClosed) evalStreamer.addLine(line, stream);
    };
    const closeStreamer = async () => {
      await evalStreamer.flush();
      evalStreamer.destroy();
      streamerClosed = true;
    };
    this.sendStepStatus(dispatch, 0, 'global-eval', ExecutionStepStatus.enum.running);

    const heartbeatTimer = setInterval(() => {
      this.send({ type: 'job.heartbeat', runId, jobId, timestamp: Date.now() });
    }, this.config.jobHeartbeatIntervalMs);

    try {
      // Inside the `try`, so a malformed dispatch reports a failed verdict
      // rather than rejecting execute() silently.
      if (!Array.isArray(config.candidates)) {
        throw new Error('Global eval round dispatch is malformed: `candidates` must be an array');
      }

      if (abortController.signal.aborted) {
        await closeStreamer();
        this.sendStepStatus(
          dispatch,
          0,
          'global-eval',
          ExecutionStepStatus.enum.skipped,
          undefined,
          evalStreamer.getTotalBytes(),
        );
        this.sendJobStatus(dispatch, ExecutionJobStatus.enum.cancelled);
        return;
      }

      await materializeGlobalEvalWorkspace({
        dispatch,
        workDir,
        log: evalLog,
        install: {
          baseEnv: agentInstallBaseEnv(this.config.trustedEnv),
          allowInstallScripts: this.config.allowInstallScripts,
        },
      });

      // Every candidate's `filter` and generator is customer code (one module
      // per distinct source file), so the whole round runs in the eval child,
      // including the diff resolution and the zx `$` handed to filters, built
      // against the child's sanitized `process.env`. `ctx.kici` calls relay
      // back over the eval union.
      const roundResult = (await this.runEvaluation({
        kind: 'global-eval',
        dispatch,
        workDir,
        config: config as unknown as Record<string, unknown>,
        emit: (line, stream) => (stream ? evalStreamLine(line, stream) : evalLog(line)),
        signal: abortController.signal,
      })) as Awaited<ReturnType<typeof runGlobalEvalRound>>;

      const running = roundResult.candidates.filter((c) => c.run).length;
      const indeterminate = roundResult.candidates.filter((c) => c.indeterminate).length;
      logger.info('Global eval round completed', {
        jobId,
        candidateCount: roundResult.candidates.length,
        running,
        indeterminate,
      });
      evalLog(
        `Global eval round completed: ${running} of ${roundResult.candidates.length} workflow(s) apply` +
          (indeterminate > 0 ? ` (${indeterminate} indeterminate)` : ''),
      );
      for (const candidate of roundResult.candidates) {
        if (candidate.indeterminate) {
          evalLog(`  ${candidate.workflowName}: indeterminate — ${candidate.reason ?? 'unknown'}`);
        }
      }

      await closeStreamer();
      this.sendStepStatus(
        dispatch,
        0,
        'global-eval',
        ExecutionStepStatus.enum.success,
        undefined,
        evalStreamer.getTotalBytes(),
      );
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success, {
        globalEvalResult: roundResult,
        globalEvalComplete: true,
      });
    } catch (err) {
      const errorMsg = toErrorMessage(err);
      logger.error('Global eval round failed', { jobId, error: errorMsg });
      evalLog(`Error: ${errorMsg}`);
      await closeStreamer();
      this.sendStepStatus(
        dispatch,
        0,
        'global-eval',
        ExecutionStepStatus.enum.failed,
        { error: errorMsg },
        evalStreamer.getTotalBytes(),
      );
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, {
        error: errorMsg,
        globalEvalFailed: true,
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  /**
   * Every customer-module load and evaluation goes through here, in a child
   * whose environment carries no agent credential; its log streams onto the
   * job's synthetic step-0 log. The caller keeps the agent's own work:
   * workspace, dependency install, tarball upload, status.
   */
  private runEvaluation<T>(args: {
    kind: EvalRequest['kind'];
    dispatch: JobDispatch;
    workDir: string;
    config: Record<string, unknown>;
    emit: (line: string, stream?: LogStream) => void;
    signal: AbortSignal;
  }): Promise<T> {
    const { jobId } = args.dispatch;
    return runEvalChild<T>({
      evalRunnerPath: resolveEvalRunnerPath(),
      request: {
        kind: args.kind,
        workDir: args.workDir,
        config: args.config,
        // A plain record, not the JobDispatch, so the set is visible here: no
        // secrets, no namespaced secrets, no agent token.
        dispatch: {
          runId: args.dispatch.runId,
          jobId: args.dispatch.jobId,
          repoUrl: args.dispatch.repoUrl,
          ref: args.dispatch.ref,
          sha: args.dispatch.sha,
          sourceAuth: args.dispatch.sourceAuth,
          workflowAuth: args.dispatch.workflowAuth,
          sourceTarUrl: args.dispatch.sourceTarUrl,
        },
      },
      onLogLine: args.emit,
      ...(this._sendApiRequest
        ? {
            onApiRequest: withBootstrapInterception((method, params) =>
              this._sendApiRequest!(method, params ?? {}),
            ),
          }
        : {}),
      trustedEnv: this.config.trustedEnv,
      signal: args.signal,
    }).catch((err) => {
      logger.debug('Evaluation child reported a failure', { jobId, error: toErrorMessage(err) });
      throw err;
    });
  }

  /**
   * Evaluates dynamic functions (environment, env, concurrencyGroup) and
   * reports the resolved values in the job.status payload; runs no workflow
   * steps. A synthetic step 0 "init" log carries console and structured output,
   * as regular steps do: module top-level code and each dynamic field function
   * run in a runCaptured scope.
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
      dynamicContext: boolean;
      dynamicEnv: boolean;
      dynamicConcurrencyGroup: boolean;
      dynamicMatrix?: boolean;
      /** From `LockWorkflow.hasFilter` — evaluate the workflow's `filter` first. */
      hasFilter?: boolean;
      /** Paths the orchestrator could only match conservatively; decided before the filter. */
      deferredPaths?: string[][];
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

    const initStreamer = this.createStepStreamer(dispatch, 0);
    // A filter may shell out, and `LogStreamer.destroy()` sets no closed flag
    // (`addLine` buffers unconditionally), so a late subprocess line would emit
    // a `log.chunk` for a terminal step. Drop it.
    let streamerClosed = false;
    const initLog = (msg: string) => {
      if (!streamerClosed) initStreamer.addLine(msg);
    };
    const initStreamLine = (line: string, stream: LogStream) => {
      if (!streamerClosed) initStreamer.addLine(line, stream);
    };
    // Idempotent: the catch also closes, after a possible throw from
    // `sendStepStatus` on the success path.
    const closeStreamer = async () => {
      if (streamerClosed) return;
      streamerClosed = true;
      await initStreamer.flush();
      initStreamer.destroy();
    };

    this.sendStepStatus(dispatch, 0, 'init', ExecutionStepStatus.enum.running);

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
        await closeStreamer();
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

      await this.prepareInitWorkspace(dispatch, workDir, initLog, config.source);

      // The module load, `filter` and every dynamic environment / env /
      // concurrencyGroup / matrix function are customer code, so they run in
      // the eval child, whose environment carries no agent credential.
      const initResult = (await this.runEvaluation({
        kind: 'init',
        dispatch,
        workDir,
        config: config as unknown as Record<string, unknown>,
        emit: (line, stream) => (stream ? initStreamLine(line, stream) : initLog(line)),
        signal: abortController.signal,
      })) as InitResult;

      logger.info('Init job completed successfully', {
        jobId,
        hasContext: initResult.contextNames !== undefined,
        hasEnv: initResult.env !== undefined,
        hasConcurrencyGroup: initResult.concurrencyGroup !== undefined,
        filterPassed: initResult.filterPassed,
        pathsPassed: initResult.pathsPassed,
      });

      if (initResult.pathsPassed === false) {
        initLog(
          `Deferred paths matched none of the changed files — '${config.workflowName}' did not trigger, so no job is dispatched`,
        );
      }
      if (initResult.filterPassed === false) {
        initLog(
          `Workflow filter returned false — '${config.workflowName}' does not apply to this event, so no job is dispatched`,
        );
      }
      initLog('Init completed successfully');
      await closeStreamer();
      this.sendStepStatus(
        dispatch,
        0,
        'init',
        ExecutionStepStatus.enum.success,
        undefined,
        initStreamer.getTotalBytes(),
      );

      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.success, {
        initResult,
        initComplete: true,
      });
    } catch (err) {
      // A throwing dynamic function fails the job; the child's `eval.error`
      // arrives as the rejection of `runEvaluation`.
      const errorMsg = toErrorMessage(err);
      logger.error('Init job failed', { jobId, error: errorMsg });
      initLog(`Error: ${errorMsg}`);
      await closeStreamer();
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

  /** Calls the DynamicJobFn at `source.index` and reports the generated jobs as LockJob[]. */
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
      /** From `LockWorkflow.hasFilter`; a `false` filter verdict generates no jobs. */
      hasFilter?: boolean;
      /** Paths the orchestrator could only match conservatively; a no-match generates no jobs. */
      deferredPaths?: string[][];
      /** Result-aware generator: declared needs + the frozen upstream snapshot. */
      resultAware?: boolean;
      declaredNeeds?: readonly unknown[];
      upstreamSnapshot?: import('@kici-dev/engine').UpstreamSnapshot;
    };

    logger.info('Starting DynamicJobFn evaluation', {
      jobId,
      workflowName: config.workflowName,
      sourceIndex: config.source.index,
    });

    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    const evalStreamer = this.createStepStreamer(dispatch, 0);
    const evalLog = (msg: string) => evalStreamer.addLine(msg);

    this.sendStepStatus(dispatch, 0, 'evaluate', ExecutionStepStatus.enum.running);

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

      await materializeEvalWorkspace(dispatch, workDir, evalLog, {
        baseEnv: agentInstallBaseEnv(this.config.trustedEnv),
        allowInstallScripts: this.config.allowInstallScripts,
      });

      // The module load, `filter`, DynamicJobFn body and every per-generated-job
      // env / environment / concurrencyGroup / matrix function are customer
      // code, so they run in the eval child, which builds its zx `$` and
      // generator context against its sanitized `process.env`. `ctx.kici` calls
      // relay back through the one privileged message on the eval union.
      const lockJobs = (await this.runEvaluation({
        kind: 'dynamic-job',
        dispatch,
        workDir,
        config: config as unknown as Record<string, unknown>,
        emit: (line, stream) => evalStreamer.addLine(line, stream),
        signal: abortController.signal,
      })) as LockJob[];

      logger.info('DynamicJobFn evaluation completed', {
        jobId,
        generatedJobCount: lockJobs.length,
        jobNames: lockJobs.map((j) => j.name),
      });

      evalLog(`Generated ${lockJobs.length} job(s): ${lockJobs.map((j) => j.name).join(', ')}`);

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
   * Clones (a full-repo run only creates the directory), then applies the
   * run's overlay tarball. Both precede the image build: the workspace is the
   * Dockerfile's build context, which a full-repo run without its overlay
   * leaves empty.
   *
   * Afterwards `checkout` is off and the overlay fields leave the job config,
   * so the runner does not reapply the overlay and its decryption key never
   * enters the container. A container job that declares `checkout: false`
   * skips this path, so its runner applies the overlay inside the container.
   */
  private async checkoutOnHost(
    dispatch: JobDispatch,
    workDir: string,
    setupLog: (line: string) => void,
  ): Promise<void> {
    const jobConfig = dispatch.jobConfig as Record<string, unknown>;
    const { isGlobal, workflowDir, sourceDir } = jobWorkspaceLayout(jobConfig, workDir);
    // Also to the step -1 log, where a bare-metal job's runner narrates the
    // same clone.
    const log = (line: string) => {
      logger.info(`[host-checkout] ${line}`, { jobId: dispatch.jobId });
      setupLog(`[host-checkout] ${line}`);
    };
    // The workflow repo and the checkout switches ride in `jobConfig`, not on
    // the dispatch envelope; the runner reads them through the same builder.
    await cloneJobRepos(
      buildCloneRequest(dispatch),
      { workDir, workflowDir, sourceDir },
      { isGlobal, log, excludeScratchFromGit },
    );

    const tarballUrl = jobConfig.tarballUrl as string | undefined;
    const cliPublicKey = jobConfig.cliPublicKey as string | undefined;
    const orchestratorPrivateKey = jobConfig.orchestratorPrivateKey as string | undefined;
    if (tarballUrl && cliPublicKey && orchestratorPrivateKey) {
      // Same target the runner uses: the repo that carries `.kici/`.
      const overlayResult = await applyOverlay({
        tarballUrl,
        cliPublicKey,
        orchestratorPrivateKey,
        repoDir: workflowDir,
      });
      log(
        `Overlay applied: ${overlayResult.filesApplied} files changed, ` +
          `${overlayResult.filesDeleted} files deleted`,
      );
      delete jobConfig.tarballUrl;
      delete jobConfig.cliPublicKey;
      delete jobConfig.orchestratorPrivateKey;
    }
    jobConfig.checkout = false;
  }

  /**
   * Through the allowlisted, isolated installer (`host-isolated-install.ts`).
   * A job `installKiciDepsOnHost` declines keeps the in-container install. The
   * job's abort signal kills the install.
   */
  private async installDepsOnHost(
    dispatch: JobDispatch,
    workDir: string,
    setupLog: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const outcome = await installKiciDepsOnHost({
      workflowDir: hostWorkflowDir(dispatch.jobConfig as Record<string, unknown>, workDir),
      dispatch,
      allowInstallScripts: this.config.allowInstallScripts === true,
      runtimeInjected: Boolean(this.config.runtimeNodeSource || this.config.runtimeImage),
      baseEnv: agentInstallBaseEnv(this.config.trustedEnv),
      // The lines arrive already redacted.
      log: (line) => {
        logger.info(line, { jobId: dispatch.jobId });
        setupLog(line);
      },
      signal,
      fileExists,
      checkEligibility: (dir, workflowRegistries) =>
        checkHostInstallEligibility(dir, {
          workflowRegistries,
          hostInstallRegistries: this.config.hostInstallRegistries,
        }),
      resolveTool: (pm) => (pm === PackageManager.Npm ? resolveHostNpm() : resolvePinnedPnpm()),
      checkLockedInstall: (kiciDir, plan, tool) => checkLockedInstall(kiciDir, plan, tool),
      runInstall: runHostIsolatedInstall,
    });
    logger.debug('Host .kici install decision', { jobId: dispatch.jobId, outcome });
  }

  /**
   * Returns the tag the sandbox must run, or `undefined` for a job that
   * declared no Dockerfile. Kept out of `setupSandboxForExecution` for the
   * 200-line ceiling, and so one `finally` bounds the build's streamer.
   */
  private async buildJobImageIfDeclared(
    dispatch: JobDispatch,
    jobConfig: Record<string, unknown>,
    workDir: string,
    abortController: AbortController,
    runtime: ContainerRuntimeEndpoint | undefined,
  ): Promise<string | undefined> {
    const container = jobConfig.container as LockJob['container'];
    if (!container || typeof container === 'string' || !container.dockerfile) return undefined;

    const streamer = this.createStepStreamer(dispatch, CONTAINER_BUILD_STEP_INDEX);
    try {
      return await runJobImageBuild({
        container,
        workDir,
        jobId: dispatch.jobId,
        // As fork-runner resolves it: a matrix leg carries its expanded `name`.
        jobName:
          (jobConfig.name as string | undefined) ??
          (jobConfig.baseJobName as string | undefined) ??
          'job',
        onLog: (line) => streamer.addLine(line),
        build: async (spec, onLog) =>
          buildJobImage({
            spec,
            cli: resolveBuildCli({ configured: this.config.containerBuildCli }),
            // The sandbox's runtime, so the build and its container share a daemon.
            ...(runtime ? { socketPath: runtimeAddress(runtime) } : {}),
            ...(dispatch.containerRegistryAuth
              ? { authconfig: dispatch.containerRegistryAuth }
              : {}),
            onLog,
            signal: abortController.signal,
          }),
        sendStepStatus: (name, state, data) =>
          this.sendStepStatus(
            dispatch,
            CONTAINER_BUILD_STEP_INDEX,
            name,
            state,
            data,
            streamer.getTotalBytes(),
          ),
      });
    } finally {
      await streamer.flush();
      streamer.destroy();
    }
  }

  private createSandbox(
    mode: ExecutionMode,
    opts: {
      runnerPath: string;
      env: Record<string, string>;
      jobId: string;
      jobConfig: Record<string, unknown>;
      registryAuth?: { username: string; password: string; serveraddress: string } | undefined;
      /** Tag produced by a `container.dockerfile` build, when the job had one. */
      builtImage?: string | undefined;
      /** The runtime a container job's container starts on. */
      containerRuntime?: ContainerRuntimeEndpoint | undefined;
    },
  ): ExecutionSandbox {
    switch (mode) {
      case 'container': {
        const containerConfig = opts.jobConfig.container;
        // A built Dockerfile tag is local, so the sandbox's pull path never fires.
        const image =
          opts.builtImage ??
          (typeof containerConfig === 'string'
            ? containerConfig
            : ((containerConfig as { image?: string })?.image ?? 'node:20-alpine'));

        return new ContainerSandbox({
          docker: opts.containerRuntime ? dockerClientFor(opts.containerRuntime) : new Docker(),
          image,
          // The self-contained bundle; see resolveRunnerBundlePath.
          runnerPath: resolveRunnerBundlePath(opts.runnerPath),
          env: opts.env,
          keepFailed: this.config.dockerKeepFailed,
          jobId: opts.jobId,
          // Secure by default. KICI_SANDBOX_NETWORK=`host` shares the host
          // network namespace (as bwrap's host-network mode does, for a
          // host-resolved registry); anything else keeps the runtime default
          // (bridge). `grant` is the per-job escape hatch the orchestrator
          // allow-lists; the agent applies only what dispatch authorized and
          // never reads the allow-list (single enforcement point).
          hardening: {
            hardened: this.config.sandboxHardened,
            readonlyRootfs: this.config.sandboxReadonlyRootfs,
            user: this.config.sandboxUser,
            pidsLimit: this.config.sandboxPidsLimit,
            memoryBytes: this.config.sandboxMemoryBytes,
            nanoCpus: this.config.sandboxNanoCpus,
            networkMode: this.config.sandboxNetwork === 'host' ? 'host' : 'default',
            grant: opts.jobConfig.sandboxGrant as ResolvedSandboxGrant | undefined,
          },
          networkIsolation: this.config.sandboxNetworkIsolation,
          // Resolved by the orchestrator: the lock carries secret names, which
          // the agent never resolves. Absent from an older orchestrator, whose
          // jobs pull anonymously.
          ...(opts.registryAuth ? { registryAuth: opts.registryAuth } : {}),
          // Reclaimed at teardown; see ContainerSandbox.buildTag.
          ...(opts.builtImage ? { buildTag: opts.builtImage } : {}),
          // The injected KiCI runtime, so the job's image needs neither Node nor
          // git. A pre-provisioned tree wins over one materialized from the
          // agent image; with both unset the runner uses the image's own `node`.
          ...(this.config.runtimeNodeSource
            ? { runtimeNodePath: this.config.runtimeNodeSource }
            : {}),
          ...(this.config.runtimeImage ? { runtimeImage: this.config.runtimeImage } : {}),
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
          // Reaps a finished job's leaked process tree. bwrap's PID namespace
          // already contains it, so detach applies only to the non-bwrap fork.
          orphanCleanup: this.config.orphanCleanup,
          ...(this.config.runnerUser ? { runnerUser: this.config.runnerUser } : {}),
        });
    }
  }

  /**
   * KICI_* system vars and user-defined workflow vars for job.context. The
   * full process.env is not sent, to avoid leaking host configuration.
   */
  private collectEnvVars(
    sanitizedEnv: Record<string, string>,
  ): Array<{ name: string; value: string; category: 'system' | 'user' | 'inherited' | 'secret' }> {
    const vars: Array<{
      name: string;
      value: string;
      category: 'system' | 'user' | 'inherited' | 'secret';
    }> = [];

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('KICI_') && value !== undefined) {
        vars.push({ name: key, value, category: 'system' });
      }
    }

    for (const [key, value] of Object.entries(sanitizedEnv)) {
      if (!key.startsWith('KICI_')) {
        vars.push({ name: key, value, category: 'user' });
      }
    }

    return vars;
  }

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
   * Mirrors a terminal cache pseudo-step (tagged with a {@link CacheStepType}
   * `step_type` and a `data.cacheOutcome`, {@link CacheOutcome}) onto the run
   * timeline as a `cache.restore` / `cache.save` run event. A no-op for
   * regular steps and hooks.
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
   * onBackpressure/onBackpressureClear are deliberately unwired: the sandbox
   * IPC boundary prevents stdout.pause()/resume(), so the streamer buffers
   * (pause) or drops (drop) internally. Operators see pressure through
   * kici_agent_log_backpressure_events_total, kici_agent_log_backpressure_active
   * and kici_agent_log_lines_dropped_total.
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
   * Created on first use. One map per job, so host-side setup lines and the
   * runner's lines for one step share a streamer and stay in order.
   */
  private getOrCreateStreamer(
    dispatch: JobDispatch,
    logStreamers: Map<number, LogStreamer>,
    stepIndex: number,
  ): LogStreamer {
    let streamer = logStreamers.get(stepIndex);
    if (!streamer) {
      streamer = this.createStepStreamer(dispatch, stepIndex);
      logStreamers.set(stepIndex, streamer);
    }
    return streamer;
  }

  /** Encrypted `secretOutputs` ride as a top-level message field, not in `data`. */
  private sendJobStatus(
    dispatch: JobDispatch,
    state: JobStatus['state'],
    data?: Record<string, unknown>,
    secretOutputs?: Record<string, { agentPublicKey: string; encrypted: string }>,
  ): void {
    // Buffered: a terminal transition lost to an at-completion disconnect would
    // leave the run "running" until stale detection, so it rides the
    // reconnect-replay buffer, not the silent-drop unbuffered path.
    //
    // Every job failure leaves through here (setup, bring-up, build, global
    // evaluation, init and dynamic jobs, and the runner's own report), so its
    // text is bounded once, here.
    this.send({
      type: 'job.status',
      messageId: randomUUID(),
      runId: dispatch.runId,
      jobId: dispatch.jobId,
      state,
      timestamp: Date.now(),
      ...(data && { data: boundJobFailureData(data) }),
      ...(secretOutputs && { secretOutputs }),
    });
  }

  /**
   * @param logBytesStreamed the step's raw stream bytes, set on terminal states;
   *   the orchestrator sums them for the `kici_org_log_bytes` capacity gauge.
   */
  private sendStepStatus(
    dispatch: JobDispatch,
    stepIndex: number,
    stepName: string,
    state: string,
    data?: Record<string, unknown>,
    logBytesStreamed?: number,
  ): void {
    // The protocol schema puts these at the top level.
    const secretsAccessed = data?.secretsAccessed as string[] | undefined;
    const concurrencyKind = data?.concurrencyKind as AgentStepStatus['concurrencyKind'] | undefined;
    const groupId = data?.groupId as string | undefined;
    const { secretsAccessed: _s, concurrencyKind: _c, groupId: _g, ...restData } = data ?? {};
    const hasRestData = Object.keys(restData).length > 0;

    // Buffered, as in sendJobStatus.
    this.send({
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
      ...(concurrencyKind !== undefined && { concurrencyKind }),
      ...(groupId !== undefined && { groupId }),
      ...(logBytesStreamed !== undefined && { logBytesStreamed }),
    });
  }
}
