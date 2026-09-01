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
import type { ChangedFilesStatus } from '@kici-dev/engine';
import type { AppConfig } from '../config.js';
import { gitClone, type GitAuth } from '../checkout/git-clone.js';
import { cloneJobRepos, type CloneJobReposRequest } from '../checkout/clone-job-repos.js';
import { GIT_CREDENTIAL_REQUEST_METHOD } from '@kici-dev/engine/protocol/messages/git-credential-relay';
import { startJobGitCredentials, type JobGitCredentials } from '../checkout/job-git-credentials.js';
import { computeChangedFiles, type ChangedFilesResult } from '../checkout/changed-files.js';
import { loadWorkflowSource, extractWorkflow } from './workflow-loader.js';
import { packKiciSource } from './source-packer.js';
import { restoreSource } from './source-restore.js';
import {
  evaluateDynamicFields,
  evaluateWorkflowFilter,
  type FilterEvalInput,
} from './init-runner.js';
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
import { withTimeout } from './timeout-util.js';
import { makeStreamingZxLog } from './streaming-zx-log.js';
import { serializeJobsToLock, MatrixExpansionError } from './dynamic-job-serializer.js';
import { buildGeneratorContext } from './generator-context.js';
import { repoIdentifierFromUrl } from './global-workflow-env.js';
import { runGlobalEvalRound, type GlobalEvalCandidate } from './global-eval-runner.js';
import { buildKiciApi, buildNeedsContext } from '@kici-dev/sdk';
import type { DynamicJobNeed, RepoInfo, EventPayload } from '@kici-dev/sdk';
import type { $ as Shell } from 'zx';
import { LogStreamer } from './log-streamer.js';
import { CONTAINER_BUILD_STEP_INDEX, runJobImageBuild } from './image-build/build-step.js';
import { buildJobImage, resolveBuildCli, sandboxSocketPath } from './image-build/build-engine.js';
import { runCaptured, type CaptureSink } from './console-capture.js';
import { applyOverlay } from './overlay-applier.js';
import { installDeps } from './dep-installer.js';
import { restoreDeps, excludeScratchFromGit } from './dep-restore.js';
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
 * `jobConfig` shape of a pre-run global eval round job.
 *
 * `roundTimeoutMs` / `candidateTimeoutMs` are optional so an older orchestrator
 * that does not send them still dispatches a runnable round; the agent falls
 * back to the defaults below.
 */
interface GlobalEvalRoundJobConfig {
  globalEvalRound: true;
  candidates: GlobalEvalCandidate[];
  event: Record<string, unknown>;
  workflowRepoUrl: string;
  workflowRef?: string;
  workflowSha?: string;
  workflowRepoIdentifier?: string;
  roundTimeoutMs?: number;
  candidateTimeoutMs?: number;
}

/** Agent-side fallbacks when the orchestrator sends no round budgets. */
const DEFAULT_GLOBAL_EVAL_ROUND_TIMEOUT_MS = 120_000;
const DEFAULT_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS = 20_000;

/**
 * Build the source / workflow repo pair the round hands to every filter and
 * generator. Mirrors the sandbox's own `setupGlobalWorkflowEnv` construction so
 * a generator's two evaluations see the same identifiers, refs, and shas — only
 * the absolute paths differ, and those are never compared.
 */
function buildRoundRepos(
  dispatch: JobDispatch,
  config: GlobalEvalRoundJobConfig,
  workflowDir: string,
  sourceDir: string,
): { sourceRepo: RepoInfo; workflowRepo: RepoInfo } {
  return {
    workflowRepo: {
      identifier: config.workflowRepoIdentifier ?? repoIdentifierFromUrl(config.workflowRepoUrl),
      path: workflowDir,
      ref: config.workflowRef,
      sha: config.workflowSha,
    },
    sourceRepo: {
      identifier: repoIdentifierFromUrl(dispatch.repoUrl),
      path: sourceDir,
      ref: dispatch.ref,
      sha: dispatch.sha,
    },
  };
}

/**
 * Resolve the changed-files list a `filter` reads — for a global eval round and
 * for a filter-bearing init job alike.
 *
 * Ground truth is the agent's own source clone; an already-`fetched` list from
 * the orchestrator is a free fast-path. A diff-less event (schedule / tag /
 * manual) resolves to `unavailable`, which makes `ctx.changedFiles` throw
 * rather than read as an empty diff — a `filter` returning false produces no
 * run at all, so a silently-empty diff would suppress the workflow with no
 * artifact anywhere to inspect.
 */
async function resolveEvalChangedFiles(
  dispatch: JobDispatch,
  event: Record<string, unknown>,
  sourceDir: string,
): Promise<ChangedFilesResult> {
  const ev = event as {
    changedFiles?: string[];
    changedFilesStatus?: ChangedFilesStatus;
  };
  if (ev.changedFilesStatus === 'fetched') {
    return { files: ev.changedFiles ?? [], status: 'fetched' };
  }
  // Same auth chain the source clone used (its own credentials were ephemeral).
  const sourceAuth = dispatch.sourceAuth ?? dispatch.workflowAuth;
  const auth: GitAuth | undefined =
    sourceAuth ??
    (dispatch.token
      ? { kind: 'basic', user: 'x-access-token', secret: dispatch.token }
      : undefined);
  return computeChangedFiles(sourceDir, event as EventPayload, auth);
}

/**
 * Directory an init job clones the source repo into when the workflow declares a
 * `filter` and the job restored `.kici/` from the cached tarball instead of
 * cloning. Named with the `__kici` prefix so it cannot collide with a repo path.
 */
const FILTER_SOURCE_DIRNAME = '__kici_filter_source__';

/**
 * Materialize the source tree a non-global workflow's `filter` reads through
 * `ctx.sourceRepo.path`.
 *
 * An init or dynamic-eval job normally restores only `.kici/` from the cached
 * source tarball — enough to import the workflow module, but a directory with no
 * repo in it. A filter that reads a file or shells out against that path would
 * get a confidently wrong answer, and `changedFiles` could not be computed at
 * all, so a filter-bearing job clones the source repo into a sibling directory.
 *
 * When no tarball was attached the job already cloned the whole repo into
 * `workDir`, and that clone is reused rather than duplicated — including the
 * local working-tree case, where there is no repo url and `workDir` IS the tree.
 *
 * A tarball with no repo url is the one combination that cannot be honoured:
 * `workDir` holds `.kici/` alone and there is nothing to clone from. Returning it
 * would hand the filter a directory in which every path test answers "absent" —
 * the exact silent lie this function exists to prevent — so it throws instead.
 */
export async function ensureFilterSourceDir(
  dispatch: JobDispatch,
  workDir: string,
): Promise<string> {
  if (!dispatch.sourceTarUrl) return workDir;
  if (!dispatch.repoUrl) {
    throw new Error(
      `Workflow declares a filter, but this job restored its source from the cache with no ` +
        `repo url to clone from — the filter would see an empty tree. Re-run with a source ` +
        `repository configured, or remove the filter.`,
    );
  }
  const sourceDir = join(workDir, FILTER_SOURCE_DIRNAME);
  const sourceAuth = dispatch.sourceAuth;
  await gitClone({
    repoUrl: dispatch.repoUrl,
    ref: dispatch.ref,
    sha: dispatch.sha,
    workDir: sourceDir,
    gitAuth: sourceAuth,
    token: sourceAuth ? undefined : dispatch.token,
  });
  return sourceDir;
}

/**
 * Restore deps, materialize the workflow source, and install `.kici/`
 * dependencies for a dynamic-eval job — everything that has to exist before its
 * workflow module can be imported.
 *
 * The init handler performs the same three steps against its own log wording and
 * keeps its own copy: sharing one helper would have to either move that
 * handler's `logger.info` call site (which Loki keys off) or parameterize it,
 * and neither is worth it for twenty lines.
 */
async function materializeEvalWorkspace(
  dispatch: JobDispatch,
  workDir: string,
  log: (msg: string) => void,
): Promise<void> {
  // 1. Restore deps (needed for workflow imports like @kici-dev/sdk)
  if (dispatch.depsUrl) {
    log('Restoring dependencies from cache');
    await restoreDeps(workDir, dispatch.depsUrl, dispatch.depsHash);
    log('Dependencies restored');
  }

  // 2. Materialize workflow source: extract from cached tarball if present,
  //    otherwise clone from the source repo.
  if (dispatch.sourceTarUrl) {
    log('Restoring workflow source from cached tarball');
    await restoreSource(workDir, dispatch.sourceTarUrl);
  } else {
    log(`Cloning ${dispatch.repoUrl} ref=${dispatch.ref}`);
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
    log('Installing dependencies locally');
    await installDeps(kiciDir, {
      npmRegistries: dispatch.npmRegistries,
      installEnvSecrets: dispatch.installEnvSecrets,
      jobIdShort: dispatch.jobId.slice(0, 8),
    });
  }
}

/**
 * Build the context a non-global workflow's `filter` is evaluated against.
 *
 * `sourceRepo` and `workflowRepo` are the same repo — that is what "non-global"
 * means — so both carry the same identifier, path, ref, and sha. The zx shell is
 * rooted at the source tree and streams into the evaluating step's log, matching
 * what the global eval round hands its own filters.
 *
 * They are two distinct objects all the same. Being the same repo is a fact
 * about their VALUES, not a licence to hand the author one object under two
 * names: a filter that mutated `ctx.sourceRepo` would silently see
 * `ctx.workflowRepo` change with it, which happens on no other path.
 */
export async function buildInitFilterInput(
  dispatch: JobDispatch,
  event: Record<string, unknown>,
  workDir: string,
  emit: (line: string, stream: LogStream) => void,
): Promise<FilterEvalInput> {
  const sourceDir = await ensureFilterSourceDir(dispatch, workDir);
  const diff = await resolveEvalChangedFiles(dispatch, event, sourceDir);
  const repo: RepoInfo = {
    identifier: repoIdentifierFromUrl(dispatch.repoUrl),
    path: sourceDir,
    ref: dispatch.ref,
    sha: dispatch.sha,
  };
  return {
    sourceRepo: repo,
    workflowRepo: { ...repo },
    changedFiles: diff.files,
    changedFilesStatus: diff.status,
    env: process.env as Record<string, string | undefined>,
    $: await buildEvalShell(sourceDir, emit),
  };
}

/**
 * Build the per-invocation zx `$` a global eval round hands to filters and
 * generators, so a `await $\`…\`` inside one is visible in the eval step's log.
 *
 * **`env` is the LIVE `process.env` reference, never a spread.** A spread is a
 * snapshot taken when the shell is built, which is before the round applies the
 * seven `KICI_*` keys — so a filter that shells out (`$\`printenv
 * KICI_SOURCE_REPO_PATH\``, or any subprocess inheriting env) would see nothing
 * here while the sandbox re-evaluation's ambient `$` resolves `process.env`
 * after `setupGlobalWorkflowEnv` has run and does see them. That is the same
 * two-worlds determinism failure the cwd choice below exists to prevent, one
 * layer down. Passing the live reference reproduces the ambient `$`'s own
 * behaviour, which is what the sandbox uses.
 *
 * `verbose: true` + `makeStreamingZxLog` honors a per-call `quiet: true`, so a
 * decrypted secret never leaks into the log.
 *
 * `emit` is a callback rather than the `LogStreamer` itself so the caller can
 * route it through its own closed-guard: `LogStreamer.destroy()` sets no closed
 * flag and `addLine` buffers unconditionally, so a subprocess line arriving
 * after the step was reported would otherwise emit a `log.chunk` for a terminal
 * step. That is the likeliest path for it — an orphaned candidate is usually
 * orphaned *because* it is waiting on a subprocess.
 */
export async function buildEvalShell(
  cwd: string,
  emit: (line: string, stream: LogStream) => void,
): Promise<typeof Shell> {
  const { $: zx$ } = await import('zx');
  return zx$({
    cwd,
    env: process.env as Record<string, string>,
    verbose: true,
    quiet: false,
    log: makeStreamingZxLog(emit) as unknown as (entry: unknown) => void,
  }) as unknown as typeof Shell;
}

/**
 * Dependencies injected into JobRunner.
 */
export interface JobRunnerDeps {
  /** Send function for WS messages (buffered; replayed on reconnect) */
  send: (msg: AgentToOrchestratorMessage) => void;
  /** Agent config */
  config: AppConfig;
  /**
   * Supervisor-owned between-jobs phase, run after every job to reap the
   * process tree, re-run declared cleanup out-of-band, delete the workdir, and
   * run the operator reset command. Optional so unit harnesses can omit it.
   */
  betweenJobsController?: BetweenJobsController;
  /** Request a pre-signed S3 upload URL from the orchestrator via WS request-response. */
  requestUploadUrl: (
    jobId: string,
    cacheType: 'source' | 'deps',
    key: {
      contentHash?: string;
      lockfileHash?: string;
      depsHash?: string;
      platform: string;
      arch: string;
    },
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
   * Relay a user-facing artifact request to the orchestrator and await the
   * response. Translates the sandbox `artifacts.request` IPC into the matching
   * `artifacts.upload.request` / `.complete` / `artifacts.download.request` WS
   * message and returns the orchestrator's response mapped back onto the IPC
   * response shape. Optional for backward compatibility.
   */
  requestUserArtifact?: (
    jobId: string,
    request: ArtifactRequestIpc,
  ) => Promise<ArtifactResponseIpc>;
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
 * Derive the self-contained runner bundle path from the resolved runner path.
 *
 * The container backend mounts the runner as a single file into the customer
 * job container, so it must run `workflow-runner-bundle.js` (zx + `@kici-dev/*`
 * inlined) rather than the external `workflow-runner.js`, which cannot resolve
 * its bare imports without the agent's node_modules / pnpm workspace. The
 * bundle is a flat sibling emitted alongside the runner by build-service.mjs.
 * bwrap / firecracker keep the external runner (they bind the workspace).
 */
export function resolveRunnerBundlePath(runnerPath: string): string {
  return join(dirname(runnerPath), 'workflow-runner-bundle.js');
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
  agentConfig: Pick<AppConfig, 'executionMode' | 'scalerManaged' | 'jobImageAgent'>,
): ExecutionMode {
  // This agent IS the job's image — the scaler spawned it from `container:`
  // with the KiCI runtime injected. Nesting another container from the same
  // image would need a runtime inside a runtime; run the steps right here.
  if (agentConfig.jobImageAgent) {
    return 'bare-metal';
  }

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
 * Resolve a job's workDir and its cleanup.
 *
 * - Default: a fresh `mkdtemp` the agent clones into and removes after the job.
 * - **In-place profile** (`inPlace` config + a `file://` source): the source's
 *   real repo path used directly as the workDir, with **no clone** and **no
 *   removal**. This is the routed `deploy:stg` profile — the operator runs their
 *   own already-built working tree (module-relative `MONOREPO_ROOT`,
 *   `node_modules`, `dist` all present). Gated to `file://` so a
 *   Platform-connected agent (https sources) can never be pushed onto a tree,
 *   and read only from agent config (never a dispatch/wire value).
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

  /** Tracks running jobs for concurrency and cancellation */
  readonly activeJobs = new Map<string, ActiveJob>();

  /** Active sandbox for the current job (used for abort). */
  private activeSandbox: ExecutionSandbox | null = null;

  /** Supervisor-owned between-jobs phase (reap / cleanup re-run / reset). */
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

    // Resolve the work directory: a fresh temp clone (default) or — under the
    // in-place profile with a file:// source — the operator's real repo path
    // used directly with no clone.
    const { workDir, cleanup, inPlace } = await resolveJobWorkDir(
      this.config.inPlace,
      dispatch.repoUrl,
    );
    // In-place: skip the git clone so the pre-built working tree is used as-is.
    // `checkout` is an agent-launch decision here (config-derived), never a
    // wire/jobConfig value that a workflow could set.
    if (inPlace) {
      (dispatch.jobConfig as Record<string, unknown>).checkout = false;
    }

    this.betweenJobsFacts = null;

    // Stand up git credentials for this job: the helper socket git talks to and
    // the grant table `withWrite` elevates. Started before the job so every
    // clone it makes is configured to use the helper, and torn down in the same
    // `finally` as the workdir so a failed job cannot leak the socket.
    const gitCredentials = await this.startGitCredentials(
      jobId,
      dispatch.jobConfig as Record<string, unknown>,
    );

    // Track this job
    const completionPromise = this.runJob(dispatch, workDir, abortController).finally(async () => {
      const facts = this.betweenJobsFacts;
      this.activeJobs.delete(jobId);
      this.activeSandbox = null;
      this.betweenJobsFacts = null;
      this.jobGitCredentials.delete(jobId);
      await gitCredentials?.close().catch(() => {
        /* best effort — the socket lives in the job dir, reaped with it */
      });

      // Between-jobs phase: reap the process tree, re-run declared cleanup
      // out-of-band, delete the workdir, run the operator reset. Owns the
      // workdir deletion so the out-of-band re-run can use the preserved dir
      // first. A throw here must never break the supervisor loop — the job has
      // already been reported.
      await this.runBetweenJobsPhase(facts, workDir, cleanup);
    });

    this.activeJobs.set(jobId, { abortController, completionPromise, runId: dispatch.runId });

    return completionPromise;
  }

  /**
   * Stand up per-job git credentials, or `undefined` when the agent has no
   * orchestrator relay (unit harnesses, offline local runs).
   *
   * A failure here must not fail the job: without a helper, git falls back to
   * its own mechanisms exactly as it did before this existed. The job simply
   * cannot push.
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
        // Declared on the job as `gitCredentials`; rides the lock file through
        // `jobConfig`, so no dispatch-schema change was needed. Values are
        // secret NAMES — the orchestrator resolves them.
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
   * Run the supervisor-owned between-jobs phase after a job finishes. Delegates
   * to the injected `BetweenJobsController` (out-of-band cleanup → reap →
   * workdir delete → operator reset) with facts captured before sandbox
   * teardown. When no controller is wired (unit harnesses) it just deletes the
   * workdir, preserving the historical behavior. Never throws.
   */
  private async runBetweenJobsPhase(
    facts: JobRunner['betweenJobsFacts'],
    workDir: string,
    deleteWorkdir: () => Promise<void>,
  ): Promise<void> {
    if (!this.betweenJobsController) {
      // No between-jobs phase configured: preserve the workdir-cleanup behavior.
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
      // The workdir may not have been deleted if the controller threw early;
      // ensure it is removed so a reused agent does not accumulate workdirs.
      await deleteWorkdir().catch(() => {});
    }
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

    // Check for the pre-run global eval round (filters + generators for every
    // candidate global workflow of one workflow repo, on one dual checkout).
    const isGlobalEvalRound = (jobConfig as { globalEvalRound?: boolean }).globalEvalRound === true;
    if (isGlobalEvalRound) {
      await this.handleGlobalEvalRound(dispatch, workDir, abortController);
      return true;
    }

    // Check for DynamicJobFn evaluation jobs (runtime job generation)
    const isDynamicJobFnEval = (jobConfig as { dynamicJobFn?: boolean }).dynamicJobFn === true;
    if (isDynamicJobFnEval) {
      await this.handleDynamicJobFn(dispatch, workDir, abortController);
      return true;
    }

    // Check for bring-up jobs (init-runner SSH bring-up; no clone, no sandbox).
    const isBringupOnly = (jobConfig as { bringupOnly?: boolean }).bringupOnly === true;
    if (isBringupOnly) {
      await this.handleBringupJob(dispatch);
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
    // Backend + failure disposition, captured for the between-jobs facts below.
    // jobFailed defaults to true: an agent-side throw before a result is a
    // failure, and a job that leaked a daemon and then threw is exactly the
    // leak the reap targets, so it must still be reaped.
    let backend: ExecutionMode = 'bare-metal';
    let jobFailed = true;

    // Owned here (not inside runSandboxExecution) so an execution that throws
    // still flushes whatever the failing step had already streamed. Without it
    // the buffered tail — which is exactly where the failure diagnostics sit —
    // dies with the streamer and the run log ends mid-step.
    const logStreamers = new Map<number, LogStreamer>();

    try {
      const setupResult = await this.setupSandboxForExecution(dispatch, workDir, abortController);
      if (!setupResult) {
        // Aborted during setup — cancellation status was already sent.
        return;
      }
      sandbox = setupResult.sandbox;
      backend = setupResult.executionMode;

      const result = await this.runSandboxExecution(
        dispatch,
        sandbox,
        abortController,
        logStreamers,
      );
      jobFailed = result.status !== ExecutionJobStatus.enum.success;

      this.reportExecutionResult(dispatch, result, logStreamers);
    } catch (error) {
      // Flush before the terminal status so the in-flight step output reaches
      // the orchestrator. destroy() is idempotent — a job that already went
      // through reportExecutionResult re-enters here with empty buffers.
      for (const streamer of logStreamers.values()) {
        streamer.destroy();
      }
      // Unexpected error in job execution
      const errorMsg = toErrorMessage(error);
      this.sendJobStatus(dispatch, ExecutionJobStatus.enum.failed, {
        error: errorMsg,
      });
    } finally {
      clearInterval(heartbeatTimer);
      if (sandbox) {
        // Capture the facts the between-jobs controller needs BEFORE teardown —
        // and on the throw path too, so a job that leaked a daemon and then hit
        // an agent-side error is still reaped. completionHooksRan /
        // declaresCleanup read the (still-live) runner handle; reap + the
        // cleanup-only re-run bind to this sandbox.
        const jobSandbox = sandbox;
        this.betweenJobsFacts = {
          completionHooksRan: jobSandbox.completionHooksRan ?? true,
          declaresCleanup: jobSandbox.declaresCleanup ?? false,
          backend,
          jobFailed,
          reap: () => jobSandbox.reap?.() ?? Promise.resolve(0),
          ...(jobSandbox.runCleanupOnly
            ? {
                cleanupSpawn: (wd: string, sig: AbortSignal) => jobSandbox.runCleanupOnly!(wd, sig),
              }
            : {}),
        };
        // Always tear down the sandbox (kills the runner child; the process
        // group survives for the reap in the between-jobs phase).
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
  ): Promise<{
    sandbox: ExecutionSandbox;
    sanitizedEnv: Record<string, string>;
    executionMode: ExecutionMode;
  } | null> {
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
      jobImageAgent: this.config.jobImageAgent,
    });
    const runnerPath = resolveRunnerPath();
    // Secrets are NOT injected into env vars -- they flow through IPC to ctx.secrets.
    const typedConfig = jobConfig as Record<string, unknown>;
    const sanitizedEnv = buildSanitizedEnv((typedConfig.env as Record<string, string>) ?? {}, {
      contextVars: (typedConfig.contextVars as Record<string, string>) ?? undefined,
      jobEnv: (typedConfig.jobEnv as Record<string, string>) ?? undefined,
      // Trusted-env is an agent-launch property read ONLY from agent config —
      // never from the dispatch/jobConfig, so a workflow cannot self-elevate.
      trustedEnv: this.config.trustedEnv,
    });

    // Step 1b: For a container job, clone on the HOST rather than inside the
    // customer's image. Two things fall out of that: the image needs no git,
    // and clone-time credentials stay on the host where the credential helper
    // already works — instead of needing a route into a container hardened
    // with `CapDrop: ALL`, which would hand anything in /workspace a direct
    // line to the credential broker.
    //
    // The runner is then told the checkout is already done, so it does not
    // re-clone over the tree we copy in.
    const hostCheckout =
      executionMode === 'container' && (jobConfig as Record<string, unknown>).checkout !== false;
    if (hostCheckout) {
      const isGlobal = (jobConfig as Record<string, unknown>).isGlobalWorkflow === true;
      await cloneJobRepos(
        dispatch as unknown as CloneJobReposRequest,
        {
          workDir,
          workflowDir: isGlobal ? join(workDir, 'workflow') : workDir,
          sourceDir: isGlobal ? join(workDir, 'source') : workDir,
        },
        {
          isGlobal,
          log: (line) => logger.info(`[host-checkout] ${line}`, { jobId }),
          excludeScratchFromGit,
        },
      );
      (jobConfig as Record<string, unknown>).checkout = false;
    }

    // Step 1c: A job may declare a Dockerfile instead of an image. Build it
    // here — after the clone, whose tree is the build context, and before the
    // sandbox, which runs the tag the build produces.
    const builtImage = await this.buildJobImageIfDeclared(
      dispatch,
      jobConfig as Record<string, unknown>,
      workDir,
      abortController,
    );

    logger.info('Creating execution sandbox', { executionMode, jobId, runnerPath });

    const sandbox = this.createSandbox(executionMode, {
      runnerPath,
      env: sanitizedEnv,
      jobId,
      jobConfig: jobConfig as Record<string, unknown>,
      registryAuth: dispatch.containerRegistryAuth,
      ...(builtImage ? { builtImage } : {}),
    });

    this.activeSandbox = sandbox;

    // Step 2: Setup sandbox (container: create + start; bare-metal: validate).
    // Thread the file:// clone-source dir(s) so a container-backend job can
    // read a local source (the bare-metal backend derives its own equivalent
    // internally and ignores this field). Empty for https/ssh remotes.
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

    return { sandbox, sanitizedEnv, executionMode };
  }

  /**
   * Drive `sandbox.executeJob` with IPC callbacks wired to the WS pipeline.
   *
   * Lazily populates `logStreamers` (owned by the caller so a throw still
   * leaves the buffered output flushable), forwards step + log + event-emit +
   * concurrency-report + api-request messages, and emits the
   * `agent.execution.start` / `agent.execution.end` lifecycle events.
   */
  private async runSandboxExecution(
    dispatch: JobDispatch,
    sandbox: ExecutionSandbox,
    abortController: AbortController,
    logStreamers: Map<number, LogStreamer>,
  ): Promise<JobExecutionResult> {
    const { runId, jobId } = dispatch;

    // Step 3: Manage LogStreamers lazily per step
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
      onLogLine: (stepIndex, line, stream) => {
        const streamer = getOrCreateLogStreamer(stepIndex);
        streamer.addLine(line, stream);
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
        ? withBootstrapInterception(async (method, params) => {
            // A git credential request from `ctx.kici.git.github.getToken()`
            // reaches the orchestrator directly rather than through the
            // credential helper, so it carries no ref of its own. Attach the
            // job's declared credential here, where the map lives.
            const patched =
              method === GIT_CREDENTIAL_REQUEST_METHOD
                ? (this.jobGitCredentials.get(jobId)?.withRef(params ?? {}) ?? params)
                : params;
            return this._sendApiRequest!(method, patched);
          })
        : undefined,
      // Wire the git write-grant relay: sandbox runner -> agent grant table.
      // Unlike its siblings this does NOT reach the orchestrator directly — the
      // grant lives in the agent, because the credential helper git spawns is a
      // separate process that consults the agent, not the runner.
      onGitGrantRequest: this.jobGitCredentials.get(jobId)?.onGitGrantRequest,
      credentialHelperPath: this.jobGitCredentials.get(jobId)?.helperPath,
      // Wire user-cache relay: sandbox runner -> agent WS -> orchestrator
      onCacheRequest: this._requestUserCache
        ? async (request) => this._requestUserCache!(jobId, request)
        : undefined,
      onProvenanceRequest: this._relayProvenance
        ? async (request) => this._relayProvenance!(jobId, request)
        : undefined,
      // Wire user-artifacts relay: sandbox runner -> agent WS -> orchestrator
      onArtifactRequest: this._requestUserArtifact
        ? async (request) => this._requestUserArtifact!(jobId, request)
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

    return result;
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
   * Handle a bring-up job: bring up a temporary init-runner on a declared-but-
   * un-agented host over SSH (fresh-box bootstrap convergence). The orchestrator
   * dispatches this synthetic `__bringup__` job to an agent holding the
   * `kici:capability:ssh-transport` capability; here we run the agent-side
   * `ensureInitRunner` helper (the privileged resolve is relayed to the
   * orchestrator, the SSH transport happens in this agent process — never
   * reaching workflow code). No clone, no sandbox — the init-runner then
   * connects under the target's agent id and the orchestrator's pinned-hold
   * drains the target's bootstrap steps onto it.
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
      // This agent process performs the SSH transport itself (the privileged
      // resolve is relayed to the orchestrator inside `ensureInitRunner`). Call
      // the agent-side helper directly with the raw orchestrator transport — do
      // NOT route through `withBootstrapInterception`, which exists to catch the
      // method coming FROM a workflow sandbox.
      // Stage a self-contained agent+Node payload onto the (possibly Node-less)
      // target so a stock rescue box boots on its vendored Node. The PRIMARY
      // source is the orchestrator's own cache bucket (pulled via a presigned
      // URL over `kici.presignAgentPackage`); KICI_AGENT_PAYLOAD_DIR selects the
      // air-gap local-dir fallback; KICI_AGENT_COMMAND (golden image) skips
      // staging entirely.
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
   * Materialize the init job's workflow source into `workDir`. A test run ships
   * its full working tree as an encrypted overlay tarball (`fullRepo`) rather
   * than a git repo, so skip the clone and let the overlay populate the
   * workspace — the same handling the normal execution-job path uses. Otherwise
   * restore from the cached tarball if present, else clone. In every case, apply
   * an attached overlay tarball afterward (test runs with uncommitted changes;
   * for a fullRepo run this is what actually populates the workspace, so the
   * init job resolves a dynamic context against the real source tree instead of
   * an empty directory).
   */
  private async materializeInitJobSource(
    dispatch: JobDispatch,
    workDir: string,
    initLog: (msg: string) => void,
  ): Promise<void> {
    const initJobConfig = dispatch.jobConfig as {
      fullRepo?: boolean;
      tarballUrl?: string;
      cliPublicKey?: string;
      orchestratorPrivateKey?: string;
    };
    if (initJobConfig.fullRepo) {
      initLog('Test run: materializing workspace from overlay (no clone)');
      await fs.mkdir(workDir, { recursive: true });
    } else if (dispatch.sourceTarUrl) {
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

    if (
      initJobConfig.tarballUrl &&
      initJobConfig.cliPublicKey &&
      initJobConfig.orchestratorPrivateKey
    ) {
      initLog('Applying overlay tarball for test run');
      const overlayResult = await applyOverlay({
        tarballUrl: initJobConfig.tarballUrl,
        cliPublicKey: initJobConfig.cliPublicKey,
        orchestratorPrivateKey: initJobConfig.orchestratorPrivateKey,
        repoDir: workDir,
      });
      logger.info('Init job: overlay applied', {
        jobId: dispatch.jobId,
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
    // Send the tarball's own hash with the REQUEST, not just the completion:
    // the object is stored under that hash, so the orchestrator needs it to
    // sign the URL. We already have it — `packNodeModules` returned it above.
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
   * Clone both repos for a global eval round and materialize the workflow
   * repo's dependencies, mirroring the sandbox's own dual-clone: the workflow
   * repo under `<workDir>/workflow`, the source repo under `<workDir>/source`.
   *
   * `.kici/` lives in the WORKFLOW repo for a global workflow, so deps and the
   * scratch-dir git exclude both apply to that checkout, never the source one.
   */
  private async checkoutForGlobalEvalRound(
    dispatch: JobDispatch,
    config: GlobalEvalRoundJobConfig,
    workflowDir: string,
    sourceDir: string,
    log: (msg: string) => void,
  ): Promise<void> {
    const workflowAuth = dispatch.workflowAuth ?? dispatch.sourceAuth;
    const sourceAuth = dispatch.sourceAuth ?? dispatch.workflowAuth;

    await fs.mkdir(workflowDir, { recursive: true });
    await fs.mkdir(sourceDir, { recursive: true });

    log(`Cloning workflow repo ${config.workflowRepoUrl} (ref: ${config.workflowRef ?? ''})`);
    const cloneStart = Date.now();
    await gitClone({
      repoUrl: config.workflowRepoUrl,
      ref: config.workflowRef ?? '',
      sha: config.workflowSha ?? '',
      workDir: workflowDir,
      gitAuth: workflowAuth,
      token: workflowAuth ? undefined : dispatch.token,
    });
    await excludeScratchFromGit(workflowDir);

    log(`Cloning source repo ${dispatch.repoUrl} (ref: ${dispatch.ref})`);
    await gitClone({
      repoUrl: dispatch.repoUrl,
      ref: dispatch.ref,
      sha: dispatch.sha,
      workDir: sourceDir,
      gitAuth: sourceAuth,
      token: sourceAuth ? undefined : dispatch.token,
    });
    cloneDurationSeconds.record((Date.now() - cloneStart) / 1000);

    if (dispatch.depsUrl) {
      log('Restoring dependencies from cache');
      await restoreDeps(workflowDir, dispatch.depsUrl, dispatch.depsHash);
    }
    if (dispatch.sourceTarUrl) {
      log('Restoring workflow source from cached tarball');
      await restoreSource(workflowDir, dispatch.sourceTarUrl);
    }
    const kiciDir = join(workflowDir, '.kici');
    if (!dispatch.depsUrl && (await fileExists(join(kiciDir, 'package.json')))) {
      log('Installing dependencies locally');
      await installDeps(kiciDir, {
        npmRegistries: dispatch.npmRegistries,
        installEnvSecrets: dispatch.installEnvSecrets,
        jobIdShort: dispatch.jobId.slice(0, 8),
      });
    }
  }

  /**
   * Handle a pre-run global eval round.
   *
   * The round runs once per (event × workflow repo) BEFORE any run row exists:
   * it checks out the workflow repo and the source repo, then runs each
   * candidate global workflow's `filter` and — for a survivor — its
   * `DynamicJobFn`s, so the orchestrator learns which workflows apply to this
   * source repo and which jobs each one generates.
   *
   * A candidate that fails is reported indeterminate inside the result, not as
   * a job failure: the round carries several unrelated org-wide workflows, and
   * one broken filter must not suppress the rest. The job itself fails only
   * when the checkout or the round machinery breaks.
   */
  private async handleGlobalEvalRound(
    dispatch: JobDispatch,
    workDir: string,
    abortController: AbortController,
  ): Promise<void> {
    const { runId, jobId, jobConfig } = dispatch;
    const config = jobConfig as unknown as GlobalEvalRoundJobConfig;
    const workflowDir = join(workDir, 'workflow');
    const sourceDir = join(workDir, 'source');

    logger.info('Starting global eval round', {
      jobId,
      // Read defensively: the opening log line runs before the `try` below, so a
      // malformed dispatch with a missing/non-array `candidates` must not throw
      // here — the guard inside the `try` turns that into a reported failure.
      candidateCount: Array.isArray(config.candidates) ? config.candidates.length : 0,
      workflowRepoIdentifier: config.workflowRepoIdentifier,
    });
    this.sendJobStatus(dispatch, ExecutionJobStatus.enum.running);

    const evalStreamer = this.createStepStreamer(dispatch, 0);
    // The round's own deadline check bounds orphaned candidate work to one
    // candidate, but it cannot preempt that candidate mid-`await` — so a late
    // `console.log` can still arrive after the step is reported and the
    // streamer destroyed. Drop those rather than buffering and emitting a
    // `log.append` for a step already marked terminal.
    let streamerClosed = false;
    const evalLog = (msg: string) => {
      if (!streamerClosed) evalStreamer.addLine(msg);
    };
    // The zx shell writes to the streamer directly, so it needs the same guard
    // — and it is the path an orphaned candidate is likeliest to use, since a
    // candidate usually outlives its budget while waiting on a subprocess.
    const evalStreamLine = (line: string, stream: LogStream) => {
      if (!streamerClosed) evalStreamer.addLine(line, stream);
    };
    const closeStreamer = async () => {
      await evalStreamer.flush();
      evalStreamer.destroy();
      streamerClosed = true;
    };
    const evalSink: CaptureSink = { addLine: (line) => evalLog(line) };
    this.sendStepStatus(dispatch, 0, 'global-eval', ExecutionStepStatus.enum.running);

    const heartbeatTimer = setInterval(() => {
      this.send({ type: 'job.heartbeat', runId, jobId, timestamp: Date.now() });
    }, this.config.jobHeartbeatIntervalMs);

    try {
      // Validate the dispatch shape inside the `try` so a malformed dispatch is
      // reported as a failed verdict rather than rejecting execute() silently.
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

      await this.checkoutForGlobalEvalRound(dispatch, config, workflowDir, sourceDir, evalLog);

      // Ground truth for the diff is the agent's own source clone; the
      // orchestrator's already-fetched list is a free fast-path. A diff-less
      // event resolves to `unavailable`, which makes a filter reading
      // `ctx.changedFiles` throw rather than silently see an empty diff.
      const diff = await resolveEvalChangedFiles(dispatch, config.event, sourceDir);

      // cwd is the round's `workDir` — the PARENT of `workflow/` and `source/` —
      // deliberately, to match what the sandbox re-evaluation hands the same
      // generator: `workflow-loader.ts` passes the ambient `$`, whose cwd is the
      // forked runner's `options.workDir` (`fork-runner.ts`). Rooting the round's
      // shell at `workflowDir` instead would give a generator running a relative
      // `$` command the workflow repo here and an almost-empty parent directory
      // on re-eval — two different worlds, which is a determinism failure.
      // Filters and generators should address either tree through
      // `ctx.sourceRepo.path` / `ctx.workflowRepo.path`, never a relative path.
      //
      // Built BEFORE the round applies the seven KICI_* keys, which is safe only
      // because the shell holds the live `process.env` rather than a snapshot —
      // see buildEvalShell.
      const evalShell = await buildEvalShell(workDir, evalStreamLine);
      const roundResult = await runCaptured(evalSink, () =>
        runGlobalEvalRound({
          workflowDir,
          sourceDir,
          repos: buildRoundRepos(dispatch, config, workflowDir, sourceDir),
          candidates: config.candidates,
          event: config.event,
          changedFiles: diff.files,
          changedFilesStatus: diff.status,
          roundTimeoutMs: config.roundTimeoutMs ?? DEFAULT_GLOBAL_EVAL_ROUND_TIMEOUT_MS,
          candidateTimeoutMs: config.candidateTimeoutMs ?? DEFAULT_GLOBAL_EVAL_CANDIDATE_TIMEOUT_MS,
          signal: abortController.signal,
          $: evalShell,
          log: {
            info: (msg: string) => evalLog(msg),
            warn: (msg: string) => evalLog(`WARN: ${msg}`),
            error: (msg: string) => evalLog(`ERROR: ${msg}`),
            debug: (msg: string) => evalLog(`DEBUG: ${msg}`),
          },
          kici: buildKiciApi(
            this._sendApiRequest
              ? withBootstrapInterception((method, params) =>
                  this._sendApiRequest!(method, params ?? {}),
                )
              : () => Promise.reject(new Error('Agent API not available')),
          ),
        }),
      );

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
      dynamicContext: boolean;
      dynamicEnv: boolean;
      dynamicConcurrencyGroup: boolean;
      dynamicMatrix?: boolean;
      /** From `LockWorkflow.hasFilter` — evaluate the workflow's `filter` first. */
      hasFilter?: boolean;
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
    // A filter may shell out, and `LogStreamer.destroy()` sets no closed flag —
    // `addLine` buffers unconditionally — so a subprocess line arriving after
    // the step was reported would emit a `log.chunk` for a terminal step. Drop
    // those instead of buffering them.
    let streamerClosed = false;
    const initLog = (msg: string) => {
      if (!streamerClosed) initStreamer.addLine(msg);
    };
    const initStreamLine = (line: string, stream: LogStream) => {
      if (!streamerClosed) initStreamer.addLine(line, stream);
    };
    // Idempotent: the catch below also closes, so a throw from `sendStepStatus`
    // on the success path would otherwise flush an already-destroyed streamer.
    const closeStreamer = async () => {
      if (streamerClosed) return;
      streamerClosed = true;
      await initStreamer.flush();
      initStreamer.destroy();
    };
    const initSink: CaptureSink = { addLine: (line) => initLog(line) };

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

      // 1. Restore deps (needed for workflow imports like @kici-dev/sdk)
      if (dispatch.depsUrl) {
        initLog('Restoring dependencies from cache');
        await restoreDeps(workDir, dispatch.depsUrl, dispatch.depsHash);
      }

      // 2. Materialize the workflow source into workDir (overlay for a test run,
      //    cached tarball, or git clone — plus any attached overlay).
      await this.materializeInitJobSource(dispatch, workDir, initLog);

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

      // 4. Materialize the source tree + diff a workflow-level `filter` reads.
      //    Built before the capture scope because it clones and shells out; the
      //    filter call itself runs inside the scope with everything else.
      const filterInput = config.hasFilter
        ? await buildInitFilterInput(dispatch, config.event, workDir, initStreamLine)
        : undefined;

      // Wrap module load + dynamic-field evaluation in a console-capture scope.
      // Any console.log in the workflow module top-level or inside the
      // workflow's filter or a dynamic environment / env / concurrencyGroup
      // function lands on this init log.
      const initResult = await runCaptured(initSink, async () => {
        const { module } = await loadWorkflowSource(
          workDir,
          config.source,
          config.contentHash,
          config.resolvedHashFiles,
        );
        const workflow = extractWorkflow(module, config.workflowName);
        initLog(
          `Evaluating dynamic fields for job '${config.targetJobName}' (env=${config.dynamicEnv} context=${config.dynamicContext} concurrencyGroup=${config.dynamicConcurrencyGroup} matrix=${config.dynamicMatrix ?? false} filter=${config.hasFilter ?? false})`,
        );
        return evaluateDynamicFields(
          workflow,
          config.targetJobName,
          config.event,
          {
            dynamicContext: config.dynamicContext,
            dynamicEnv: config.dynamicEnv,
            dynamicConcurrencyGroup: config.dynamicConcurrencyGroup,
            dynamicMatrix: config.dynamicMatrix ?? false,
            hasFilter: config.hasFilter ?? false,
          },
          config.timeoutMs,
          filterInput,
        );
      });

      logger.info('Init job completed successfully', {
        jobId,
        hasContext: initResult.contextNames !== undefined,
        hasEnv: initResult.env !== undefined,
        hasConcurrencyGroup: initResult.concurrencyGroup !== undefined,
        filterPassed: initResult.filterPassed,
      });

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
      /**
       * From `LockWorkflow.hasFilter` — evaluate the workflow's `filter` before
       * the generator. A `false` verdict generates no jobs at all.
       */
      hasFilter?: boolean;
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

      await materializeEvalWorkspace(dispatch, workDir, evalLog);

      // 3. Build a per-invocation zx `$` whose subprocess stdout / stderr flows
      //    into the eval streamer. Mirrors the sandbox's $.log callback wiring in
      //    workflow-runner.ts:createSandboxStepContext. Without this, `await $`...``
      //    calls inside the DynamicJobFn body or inside matrix fns would be
      //    invisible (zx pipes child stdio to an internal VoidStream and only
      //    surfaces it through the log callback).
      // `buildEvalShell` resolves the LIVE `process.env` (never a spread), so a
      // workflow module that sets an env var at import time is visible to a
      // subprocess the DynamicJobFn shells out to — matching the global eval
      // round rather than snapshotting env before the module loads. Its
      // `verbose: true` + `makeStreamingZxLog` wiring honors a per-call
      // `quiet: true` (e.g. a sops decrypt), so a decrypted secret never leaks
      // into the eval log.
      const scopedDollar = await buildEvalShell(workDir, (line, stream) =>
        evalStreamer.addLine(line, stream),
      );

      const evalSink: CaptureSink = { addLine: (line) => evalStreamer.addLine(line) };

      // The workflow's `filter` gates the generator too, not just the static
      // jobs' init round. Without this a same-repo workflow whose jobs are all
      // generated would keep the filter entirely inert, and a mixed workflow
      // would deterministically half-dispatch: static jobs suppressed, generated
      // jobs running. Built before the capture scope because it clones.
      const filterInput = config.hasFilter
        ? await buildInitFilterInput(dispatch, config.event, workDir, (line, stream) =>
            evalStreamer.addLine(line, stream),
          )
        : undefined;

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
          ? withBootstrapInterception((method, params) =>
              this._sendApiRequest!(method, params ?? {}),
            )
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

        if (config.hasFilter) {
          if (!(await evaluateWorkflowFilter(workflow, config.event, filterInput, timeoutMs))) {
            evalLog(
              `Workflow filter returned false — '${config.workflowName}' does not apply to this ` +
                `event, so its generator is not run and no jobs are generated`,
            );
            return [];
          }
        }

        const dynamicFn = extractDynamicJobFn(workflow, config.source.index);

        evalLog(`Evaluating DynamicJobFn (index ${config.source.index}, timeout ${timeoutMs}ms)`);

        // Result-aware generators see their declared upstreams' frozen outputs
        // as ctx.needs, built from the snapshot the orchestrator captured at eval
        // dispatch (never a live read — see the determinism contract).
        const needs = buildEvalNeedsContext(config);

        // Built through the shared builder so this first evaluation and the
        // sandbox re-evaluation (workflow-loader.ts) cannot drift apart.
        const context = buildGeneratorContext({
          workflowName: config.workflowName,
          event: config.event,
          env: process.env as Record<string, string | undefined>,
          ...(needs && { needs }),
          $: scopedDollar,
          log: dynamicJobLogger,
          kici,
        });

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
   * Build the job's container image when it declared a Dockerfile, and return
   * the tag the sandbox must run.
   *
   * Returns `undefined` for every other job — one with no container, or one
   * naming a finalized image — which is the common case and costs nothing.
   *
   * Extracted from `setupSandboxForExecution` so that function stays inside the
   * 200-line ceiling, and so the build's streamer lifecycle is visibly bounded
   * by one `finally`.
   */
  private async buildJobImageIfDeclared(
    dispatch: JobDispatch,
    jobConfig: Record<string, unknown>,
    workDir: string,
    abortController: AbortController,
  ): Promise<string | undefined> {
    const container = jobConfig.container as LockJob['container'];
    if (!container || typeof container === 'string' || !container.dockerfile) return undefined;

    const streamer = this.createStepStreamer(dispatch, CONTAINER_BUILD_STEP_INDEX);
    try {
      return await runJobImageBuild({
        container,
        workDir,
        jobId: dispatch.jobId,
        // Same resolution fork-runner uses for the runner request: a matrix leg
        // carries its expanded `name`, everything else its plain one.
        jobName:
          (jobConfig.name as string | undefined) ??
          (jobConfig.baseJobName as string | undefined) ??
          'job',
        onLog: (line) => streamer.addLine(line),
        build: async (spec, onLog) =>
          buildJobImage({
            spec,
            cli: resolveBuildCli({ configured: this.config.containerBuildCli }),
            // The sandbox's own socket, so the build and the container that
            // runs it land on the same daemon.
            socketPath: sandboxSocketPath(),
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
      registryAuth?: { username: string; password: string; serveraddress: string } | undefined;
      /** Tag produced by a `container.dockerfile` build, when the job had one. */
      builtImage?: string | undefined;
    },
  ): ExecutionSandbox {
    switch (mode) {
      case 'container': {
        const containerConfig = opts.jobConfig.container;
        // A job that declared a Dockerfile has already been built; run THAT tag.
        // It is local by construction, so the sandbox's pull path never fires.
        const image =
          opts.builtImage ??
          (typeof containerConfig === 'string'
            ? containerConfig
            : ((containerConfig as { image?: string })?.image ?? 'node:20-alpine'));

        return new ContainerSandbox({
          docker: new Docker(),
          image,
          // The container backend runs the self-contained bundle (zx +
          // @kici-dev/* inlined) so the single-file runner mount loads inside a
          // bare job container. bwrap / firecracker keep the external runner.
          runnerPath: resolveRunnerBundlePath(opts.runnerPath),
          env: opts.env,
          keepFailed: this.config.dockerKeepFailed,
          jobId: opts.jobId,
          // Secure-by-default job-container posture from agent config. The
          // network posture honors KICI_SANDBOX_NETWORK: `host` shares the host
          // network namespace (parity with the bwrap host-network mode — needed
          // when a workflow must reach a host-resolved registry), anything else
          // keeps the runtime default (bridge). The container backend's default
          // therefore stays bridge unless the operator opts into host. The
          // `grant` is the dispatch-resolved per-job escape hatch (allow-listed
          // orchestrator-side); the agent applies only what dispatch authorized
          // and never reads the allow-list itself (single enforcement point).
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
          // Resolved by the ORCHESTRATOR — the lock carries secret names and
          // the agent never resolves them itself. Absent on an older
          // orchestrator, which pulls anonymously exactly as before.
          ...(opts.registryAuth ? { registryAuth: opts.registryAuth } : {}),
          // Reclaimed at teardown; see ContainerSandbox.buildTag.
          ...(opts.builtImage ? { buildTag: opts.builtImage } : {}),
          // Where the injected KiCI runtime comes from, so the job's image
          // needs neither Node nor git. A pre-provisioned tree wins; otherwise
          // the sandbox materializes one out of the agent image. Both unset
          // leaves the historical contract in force — the runner launches on
          // the image's own `node`.
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
          // Reap a finished job's leaked process tree (bwrap already contains
          // it via its PID namespace, so detach only applies to the non-bwrap
          // fork branch inside the sandbox).
          orphanCleanup: this.config.orphanCleanup,
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
    // Buffered send: a terminal transition dropped by an at-completion disconnect
    // is the most costly frame to lose (the run would sit "running" until stale
    // detection). Routing through send() enqueues it in the reconnect-replay
    // buffer instead of the silent-drop unbuffered path.
    this.send({
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
    // Extract top-level fields from data (per protocol schema): secretsAccessed
    // plus the parallel concurrency role + group id.
    const secretsAccessed = data?.secretsAccessed as string[] | undefined;
    const concurrencyKind = data?.concurrencyKind as AgentStepStatus['concurrencyKind'] | undefined;
    const groupId = data?.groupId as string | undefined;
    const { secretsAccessed: _s, concurrencyKind: _c, groupId: _g, ...restData } = data ?? {};
    const hasRestData = Object.keys(restData).length > 0;

    // Buffered send (same rationale as sendJobStatus): step-status frames ride
    // the reconnect-replay buffer so a disconnect at a step transition cannot
    // silently drop it.
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
