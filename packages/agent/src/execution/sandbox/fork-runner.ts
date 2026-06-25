/**
 * Shared fork-based execution logic used by BareMetalSandbox and FirecrackerSandbox.
 *
 * Both backends use child_process.fork() (or spawn via bwrap) with Node.js IPC
 * channel for communication. This module extracts the common fork + IPC dispatch
 * logic to avoid duplication.
 */

import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobDispatch, CheckMode } from '@kici-dev/engine';
import { ExecutionJobStatus, ExecutionStepStatus } from '@kici-dev/engine';
import type { JobExecutionOptions, JobExecutionResult } from './types.js';
import type {
  RunnerToAgentMessage,
  AgentToRunnerMessage,
  EventEmitRequest,
  ConcurrencyReportMessage,
  AgentApiRequestIpc,
  CacheRequestIpc,
  ProvenanceRequestIpc,
  StepApprovalRequestIpc,
  JobExecutionRequest,
} from './ipc-protocol.js';
import { buildSanitizedEnv } from './env-sanitizer.js';
import { encryptSecretOutputs } from './secret-encryption.js';
import { toErrorMessage } from '@kici-dev/shared';

/** Options for creating a fork-based runner. */
interface ForkRunnerOptions {
  /** Absolute path to the compiled workflow-runner.js. */
  runnerPath: string;
  /** Pre-sanitized base environment (system + user vars). */
  env: Record<string, string>;
  /** If true, wrap execution in bubblewrap for namespace isolation. */
  useBwrap?: boolean;
  /** Working directory for the child process. */
  workDir?: string;
  /**
   * If true, enable network isolation via bwrap --unshare-net.
   * Creates a network namespace with only loopback -- no external connectivity.
   * Intentionally strict: bare-metal is for trusted environments only.
   * Only effective when useBwrap is also true.
   */
  networkIsolation?: boolean;
  /**
   * Extra absolute host paths to bind read-only into the bwrap sandbox.
   * Used by the bare-metal sandbox to expose `file://` clone source dirs
   * (internal provider, dev/E2E) to the workflow runner so its `git clone`
   * step can read from them. Ignored when useBwrap=false.
   */
  extraReadOnlyBinds?: string[];
  /**
   * Agent-level maximum grace period in milliseconds.
   * The effective grace period is Math.min(jobGracePeriod, maxGracePeriodMs).
   * Defaults to 30_000 (30 seconds).
   */
  maxGracePeriodMs?: number;
}

/**
 * Fork-runner cancel state machine.
 *
 * Prevents race conditions between force-cancel and hook completion:
 * - running: normal execution
 * - cancelling: graceful cancel in progress (SIGTERM sent, hooks may be running)
 * - force_killing: force cancel (SIGKILL sent, no hooks)
 */
type ForkState = 'running' | 'cancelling' | 'force_killing';

/** State of a running fork-based child process. */
export interface ForkRunnerHandle {
  /** The child process instance. */
  child: ChildProcess;
  /** Promise that resolves when the job completes. */
  result: Promise<JobExecutionResult>;
  /** Abort the running job (SIGTERM -> SIGKILL). Legacy method -- prefer cancel(). */
  abort: () => Promise<void>;
  /** Kill the child process if still running. */
  kill: () => void;
  /**
   * Cancel the running job with two-level support.
   *
   * @param force If false: graceful cancel (SIGTERM, grace period, then SIGKILL).
   *              If true: force cancel (SIGKILL immediately, skip hooks).
   * @param gracePeriodMs Grace period in ms before escalating to SIGKILL (graceful only).
   *                      Capped by the agent's maxGracePeriodMs.
   */
  cancel: (force: boolean, gracePeriodMs?: number) => void;
}

/**
 * Build a JobExecutionRequest from a JobDispatch.
 *
 * Maps orchestrator dispatch fields to the subset needed by the workflow runner.
 */
export function buildRequest(dispatch: JobDispatch, workDir: string): JobExecutionRequest {
  const jobConfig = dispatch.jobConfig as Record<string, unknown>;

  return {
    runId: dispatch.runId,
    jobId: dispatch.jobId,
    workDir,
    repoUrl: dispatch.repoUrl,
    ref: dispatch.ref,
    sha: dispatch.sha,
    token: dispatch.token,
    sourceAuth: dispatch.sourceAuth,
    workflowAuth: dispatch.workflowAuth,

    sourceTarUrl: dispatch.sourceTarUrl,
    sourceTarHash: dispatch.sourceTarHash,
    depsUrl: dispatch.depsUrl,
    depsHash: dispatch.depsHash,

    workflowName: (jobConfig.workflowName as string) ?? '',
    // The orchestrator names the dispatch envelope by the expanded child name
    // (jobConfig.name) for reporting, but the job is defined once under its base
    // name in source — use baseJobName for findJob/extractSteps + ctx.job.name.
    jobName: (jobConfig.baseJobName as string | undefined) ?? (jobConfig.name as string) ?? '',
    runsOn: (jobConfig.runsOn as string) ?? '',
    matrixValues: jobConfig.matrixValues as Record<string, unknown> | undefined,
    host: jobConfig.host as string | undefined,
    agent: jobConfig.agent as
      | { host: string; labels: string[]; platform?: string; arch?: string }
      | undefined,
    dispatchInputs: jobConfig.dispatchInputs as Record<string, unknown> | undefined,
    fanoutIndex: jobConfig.fanoutIndex as number | undefined,
    fanoutTotal: jobConfig.fanoutTotal as number | undefined,

    secrets: dispatch.secrets,
    namespacedSecrets: dispatch.namespacedSecrets,

    sourceFile: (jobConfig.source as { file?: string } | undefined)?.file,
    contentHash: jobConfig.contentHash as string | undefined,
    resolvedHashFiles: jobConfig.resolvedHashFiles as string[] | undefined,

    maxLogSizeBytes: dispatch.maxLogSizeBytes,
    jobTimeoutMs: jobConfig.timeout as number | undefined,

    container: jobConfig.container as Record<string, unknown> | undefined,
    event: jobConfig.event as Record<string, unknown> | undefined,
    provider: jobConfig.provider as string | undefined,
    checkout: (jobConfig.checkout as boolean | undefined) ?? true,
    isTestRun: (jobConfig.isTestRun as boolean | undefined) ?? false,
    fullRepo: (jobConfig.fullRepo as boolean | undefined) ?? false,
    checkMode: jobConfig.checkMode as CheckMode | undefined,

    tarballUrl: jobConfig.tarballUrl as string | undefined,
    cliPublicKey: jobConfig.cliPublicKey as string | undefined,
    orchestratorPrivateKey: jobConfig.orchestratorPrivateKey as string | undefined,

    runPublicKey: dispatch.runPublicKey,

    environment: jobConfig.environment as string | undefined,
    environmentVars: jobConfig.environmentVars as Record<string, string> | undefined,
    jobEnv: jobConfig.jobEnv as Record<string, string> | undefined,

    // Global workflow fields
    isGlobalWorkflow: jobConfig.isGlobalWorkflow as boolean | undefined,
    workflowRepoUrl: jobConfig.workflowRepoUrl as string | undefined,
    workflowRef: jobConfig.workflowRef as string | undefined,
    workflowSha: jobConfig.workflowSha as string | undefined,
    workflowRepoIdentifier: jobConfig.workflowRepoIdentifier as string | undefined,

    hasConcurrencyGroup: (jobConfig.hasConcurrencyGroup as boolean | undefined) ?? false,
    concurrencyEvaluationTimeoutMs: jobConfig.concurrencyEvaluationTimeoutMs as number | undefined,
    branch: dispatch.ref,

    // Plain outputs from upstream jobs for ctx.jobOutputs()
    upstreamJobOutputs: dispatch.upstreamJobOutputs as
      | Record<string, Record<string, unknown>>
      | undefined,

    // Terminal statuses + declared needs that shape ctx.needs for steps.
    upstreamJobStatuses: dispatch.upstreamJobStatuses as
      | Record<string, import('@kici-dev/engine').ExecutionJobStatus>
      | undefined,
    jobNeeds: jobConfig.needs as readonly unknown[] | undefined,

    // Private-registry install auth (Phase 4 of private-registry plan).
    npmRegistries: dispatch.npmRegistries,
    installEnvSecrets: dispatch.installEnvSecrets,
    jobIdShort: dispatch.jobId.slice(0, 8),

    // DynamicJobFn source (for re-evaluating the function to extract step functions)
    dynamicSource: jobConfig.dynamicSource as
      | { index: number; event: Record<string, unknown>; expectedJobNames?: string[] }
      | undefined,
  };
}

/**
 * Build bubblewrap (bwrap) arguments for namespace isolation.
 *
 * Creates a sandboxed filesystem view with:
 * - Read-only bind mounts for system directories (/usr, /lib, /bin, etc.)
 * - Read-only bind mount for Node.js binary
 * - Writable bind mount for the workspace directory
 * - Private /dev, /proc, /tmp
 * - PID and IPC namespace isolation
 * - Die-with-parent and new-session for process lifecycle safety
 *
 * When networkIsolation is true, --unshare-net creates a separate network namespace
 * with only loopback (no external connectivity). This is intentionally strict:
 * bare-metal mode is for trusted environments only, and full network isolation
 * is simpler and more secure than selective blocking.
 */
export function buildBwrapArgs(
  workDir: string,
  nodeExecPath: string,
  networkIsolation: boolean = false,
  runnerPath?: string,
  extraReadOnlyBinds: string[] = [],
): string[] {
  const args: string[] = [
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/sbin',
    '/sbin',
    '--ro-bind',
    '/etc/resolv.conf',
    '/etc/resolv.conf',
    '--ro-bind',
    '/etc/ssl',
    '/etc/ssl',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--bind',
    workDir,
    '/workspace',
    '--chdir',
    '/workspace',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    '--new-session',
  ];

  // Full network isolation: creates a separate network namespace with only loopback.
  // No external connectivity -- bare-metal is for trusted environments only.
  if (networkIsolation) {
    args.push('--unshare-net');
  }

  // /lib64 may not exist on all systems (arm64 typically doesn't have it).
  // On x86_64 Debian/Ubuntu it is usually a symlink to /usr/lib64. When
  // present we add an extra bind mount for it so the workflow runner can
  // find its 64-bit loader (ld-linux-x86-64.so.2) and shared libraries.
  if (existsSync('/lib64')) {
    // Insert AFTER the /lib bind mount triple (--ro-bind /lib /lib).
    // libIdx points at the source arg ('/lib'), so we advance by 2 to land
    // past the target arg. Inserting at libIdx+1 would corrupt the arg list
    // (bwrap would then receive `--ro-bind /lib --ro-bind /lib64 /lib64 /lib`
    // and interpret the stray '/lib64' as the exec command, crashing with
    // `bwrap: execvp /lib64: No such file or directory`).
    const libIdx = args.indexOf('/lib', args.indexOf('--ro-bind') + 1);
    if (libIdx !== -1) {
      args.splice(libIdx + 2, 0, '--ro-bind', '/lib64', '/lib64');
    }
  }

  // Bind-mount the Node.js install ROOT read-only (may be outside /usr/bin,
  // e.g., nvm/mise/asdf). We bind the parent of the binary's directory rather
  // than just the binary's directory because Node distributions co-locate
  // npm and other tooling under siblings of `bin/`:
  //
  //   $NODE_ROOT/bin/node            ← process.execPath
  //   $NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js
  //   $NODE_ROOT/share/...
  //
  // Without binding the whole root, `npm install` (used by the workflow
  // runner during `installDeps`) crashes with
  // `Cannot find module '$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js'`.
  const nodeDir = dirname(nodeExecPath);
  const nodeInstallRoot = dirname(nodeDir);
  if (
    !nodeInstallRoot.startsWith('/usr') &&
    !nodeInstallRoot.startsWith('/bin') &&
    nodeInstallRoot !== '/' &&
    nodeInstallRoot !== ''
  ) {
    args.push('--ro-bind', nodeInstallRoot, nodeInstallRoot);
  } else if (!nodeDir.startsWith('/usr') && !nodeDir.startsWith('/bin')) {
    // Edge case: binary lives directly at `/bin/node` or `/usr/bin/node`
    // (handled by the /usr or /bin ro-binds above) — fall back to binding
    // just the binary's parent dir.
    args.push('--ro-bind', nodeDir, nodeDir);
  }

  // Bind-mount the workflow-runner.js so it (and its dependencies) is
  // reachable from inside the sandbox under its real absolute path.
  //
  // Two cases:
  //
  // 1. **pnpm workspace install (dev/staging).** runnerPath lives somewhere
  //    like /repo/packages/agent/dist/workflow-runner.js, and pnpm's
  //    symlinked node_modules point at sibling packages
  //    (e.g. /repo/packages/shared). We must bind the entire workspace
  //    root (the directory containing pnpm-workspace.yaml) so all symlink
  //    targets resolve. Binding only the runner dir or its node_modules
  //    is not enough — symlinks resolve into unbound territory and Node
  //    crashes with `Cannot find package '@kici-dev/shared'`.
  //
  // 2. **Single-tree install (production tarball or bundled binary).**
  //    No pnpm-workspace.yaml is found walking up from runnerPath. Fall
  //    back to binding runnerDir plus every node_modules in its parent
  //    chain — this catches both the bundled-in-place case and a flat
  //    `node_modules` next to dist/.
  //
  // Without this the bwrap'd Node process crashes immediately with
  // `Cannot find module '/.../workflow-runner.js'` or
  // `Cannot find package '...'`.
  const boundDirs = new Set<string>();
  if (runnerPath) {
    const runnerDir = dirname(runnerPath);

    // Find the pnpm workspace root by walking up from runnerDir.
    let workspaceRoot: string | undefined;
    let cursor: string = runnerDir;
    while (cursor && cursor !== '/' && cursor !== dirname(cursor)) {
      if (existsSync(`${cursor}/pnpm-workspace.yaml`)) {
        workspaceRoot = cursor;
        break;
      }
      cursor = dirname(cursor);
    }

    if (
      workspaceRoot &&
      !workspaceRoot.startsWith('/usr') &&
      !workspaceRoot.startsWith('/bin') &&
      !workspaceRoot.startsWith('/workspace')
    ) {
      // Single bind covers all packages and their symlinked deps.
      args.push('--ro-bind', workspaceRoot, workspaceRoot);
      boundDirs.add(workspaceRoot);
    } else {
      // Production / single-tree install fallback.
      // Skip the runner bind if it's already covered by the node install root
      // (single-binary distributions where node and the runner ship together).
      const alreadyCoveredByNode =
        runnerDir === nodeDir ||
        runnerDir === nodeInstallRoot ||
        runnerDir.startsWith(`${nodeInstallRoot}/`);
      if (
        !runnerDir.startsWith('/usr') &&
        !runnerDir.startsWith('/bin') &&
        !runnerDir.startsWith('/workspace') &&
        !alreadyCoveredByNode &&
        !boundDirs.has(runnerDir)
      ) {
        args.push('--ro-bind', runnerDir, runnerDir);
        boundDirs.add(runnerDir);
      }
      // Walk up from runnerDir to '/' and bind every node_modules we find.
      cursor = runnerDir;
      while (cursor && cursor !== '/' && cursor !== dirname(cursor)) {
        const candidate = `${cursor}/node_modules`;
        if (
          existsSync(candidate) &&
          !candidate.startsWith('/usr') &&
          !candidate.startsWith('/bin') &&
          !candidate.startsWith('/workspace') &&
          !boundDirs.has(candidate)
        ) {
          args.push('--ro-bind', candidate, candidate);
          boundDirs.add(candidate);
        }
        cursor = dirname(cursor);
      }
    }
  }

  // Caller-supplied read-only binds (e.g. file:// clone source paths). The
  // workflow runner clones the repo from inside the sandbox, so any local
  // file:// URL must have its source dir mounted or `git clone` will fail
  // with `does not appear to be a git repository`.
  for (const extra of extraReadOnlyBinds) {
    if (
      !extra ||
      boundDirs.has(extra) ||
      extra.startsWith('/usr') ||
      extra.startsWith('/bin') ||
      extra.startsWith('/workspace') ||
      !existsSync(extra)
    ) {
      continue;
    }
    args.push('--ro-bind', extra, extra);
    boundDirs.add(extra);
  }

  return args;
}

/**
 * Spawn the workflow-runner child process. Returns the child handle and a
 * boolean indicating whether the spawn produced a usable PID. On Windows
 * services (shawl) fork() can fail silently when IPC pipes cannot be set up;
 * the caller treats `pidAssigned=false` as an immediate failure.
 */
function spawnRunnerChild(
  options: ForkRunnerOptions,
  sanitizedEnv: Record<string, string>,
  effectiveWorkDir: string,
): { child: ChildProcess; pidAssigned: boolean } {
  const {
    runnerPath,
    useBwrap = false,
    networkIsolation = false,
    extraReadOnlyBinds = [],
  } = options;

  let child: ChildProcess;
  if (useBwrap) {
    const bwrapArgs = buildBwrapArgs(
      effectiveWorkDir,
      process.execPath,
      networkIsolation,
      runnerPath,
      extraReadOnlyBinds,
    );
    child = spawn('bwrap', [...bwrapArgs, process.execPath, runnerPath], {
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
  } else {
    child = fork(runnerPath, [], {
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: effectiveWorkDir || undefined,
    });
  }
  return { child, pidAssigned: Boolean(child.pid) };
}

/** Drain the child's stdout (preventing pipe-buffer deadlock) and capture
 *  the last N stderr lines for crash diagnostics. The returned array is
 *  mutated in place by the stderr listener. */
function setupChildStdioCapture(child: ChildProcess): string[] {
  const stderrLines: string[] = [];
  const MAX_STDERR_LINES = 20;

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      process.stderr.write(`[workflow-runner:stdout] ${chunk.toString().trimEnd()}\n`);
    });
  }

  if (child.stderr) {
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
        process.stderr.write(`[workflow-runner:stderr] ${line}\n`);
      }
    });
  }

  return stderrLines;
}

/** Send-helper that swallows EPIPE / closed-channel errors. Called from
 *  every IPC relay path because the channel may close before we respond. */
function safeSendToChild(child: ChildProcess, msg: AgentToRunnerMessage): void {
  try {
    child.send(msg);
  } catch {
    // IPC channel may be closed if runner already exited
  }
}

/** Closure-captured state shared by the IPC message handler, exit handler,
 *  and error handler. Mutating fields (`forkState`, `jobCompleted`,
 *  `cancelTimers`) live on the object so helpers can update them in place
 *  while the outer closure still observes the current value. */
interface ForkRunnerCtx {
  child: ChildProcess;
  execOptions: JobExecutionOptions;
  effectiveWorkDir: string;
  stepNames: Map<number, string>;
  startTime: number;
  resolve: (result: JobExecutionResult) => void;
  cancelTimers: NodeJS.Timeout[];
  state: { forkState: ForkState; jobCompleted: boolean };
  stderrLines: string[];
}

function clearAllCancelTimers(ctx: ForkRunnerCtx): void {
  for (const timer of ctx.cancelTimers) clearTimeout(timer);
  ctx.cancelTimers.length = 0;
}

/** Relay `event.emit` to the orchestrator via the supplied callback and
 *  send the response (or an error response) back into the sandbox runner. */
function relayEventEmit(msg: EventEmitRequest, ctx: ForkRunnerCtx): void {
  ctx.execOptions.onEventEmit(msg).then(
    (response) => safeSendToChild(ctx.child, response),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'event.emit.response',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/** Relay `concurrency.report` and pipe the orchestrator ack (or a synthetic
 *  cancel ack on relay failure) back into the sandbox runner. */
function relayConcurrencyReport(msg: ConcurrencyReportMessage, ctx: ForkRunnerCtx): void {
  ctx.execOptions.onConcurrencyReport(msg).then(
    (ack) => safeSendToChild(ctx.child, ack),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'concurrency.ack',
        action: 'cancel' as const,
        reason: toErrorMessage(err),
      }),
  );
}

/** Relay `agent.api.request` and pipe the orchestrator response (or an error
 *  response, or a "not configured" response when the agent didn't provide
 *  the callback) back into the sandbox runner. */
function relayAgentApiRequest(msg: AgentApiRequestIpc, ctx: ForkRunnerCtx): void {
  if (!ctx.execOptions.onApiRequest) {
    safeSendToChild(ctx.child, {
      type: 'agent.api.response',
      requestId: msg.requestId,
      error: 'Agent API not available in this agent configuration',
    });
    return;
  }
  ctx.execOptions.onApiRequest(msg.method, msg.params).then(
    (result) =>
      safeSendToChild(ctx.child, {
        type: 'agent.api.response',
        requestId: msg.requestId,
        result,
      }),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'agent.api.response',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/** Relay `cache.request` and pipe the orchestrator response (or an error
 *  response, or a "not configured" response when the agent didn't provide
 *  the callback) back into the sandbox runner. */
function relayCacheRequest(msg: CacheRequestIpc, ctx: ForkRunnerCtx): void {
  if (!ctx.execOptions.onCacheRequest) {
    safeSendToChild(ctx.child, {
      type: 'cache.response',
      requestId: msg.requestId,
      error: 'Cache not available in this agent configuration',
    });
    return;
  }
  ctx.execOptions.onCacheRequest(msg).then(
    (response) => safeSendToChild(ctx.child, response),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'cache.response',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/** Relay `provenance.request` and pipe the orchestrator response (or an error
 *  response, or a "not configured" response when the callback isn't wired) back
 *  into the sandbox runner. */
function relayProvenanceRequest(msg: ProvenanceRequestIpc, ctx: ForkRunnerCtx): void {
  if (!ctx.execOptions.onProvenanceRequest) {
    safeSendToChild(ctx.child, {
      type: 'provenance.response',
      requestId: msg.requestId,
      error: 'Provenance not available in this agent configuration',
    });
    return;
  }
  ctx.execOptions.onProvenanceRequest(msg).then(
    (response) => safeSendToChild(ctx.child, response),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'provenance.response',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/** Relay `approval.request` and pipe the orchestrator's resolution (or a
 *  fail-closed reject when the callback isn't wired or the relay throws) back
 *  into the sandbox runner. */
function relayApprovalRequest(msg: StepApprovalRequestIpc, ctx: ForkRunnerCtx): void {
  if (!ctx.execOptions.onApprovalRequest) {
    safeSendToChild(ctx.child, {
      type: 'approval.resolved',
      requestId: msg.requestId,
      error: 'Approvals not available in this agent configuration',
    });
    return;
  }
  ctx.execOptions.onApprovalRequest(msg).then(
    (response) => safeSendToChild(ctx.child, response),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'approval.resolved',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/** Resolve the result promise for `job.complete` IPC messages. Encrypts
 *  secret outputs (when a runPublicKey is available) and overrides status to
 *  `cancelled` if a cancel was already in flight. */
function handleJobComplete(
  msg: Extract<RunnerToAgentMessage, { type: 'job.complete' }>,
  dispatch: JobDispatch,
  ctx: ForkRunnerCtx,
): void {
  ctx.state.jobCompleted = true;

  let encryptedSecretOutputs:
    | Record<string, { agentPublicKey: string; encrypted: string }>
    | undefined;
  if (msg.secretOutputs && dispatch.runPublicKey) {
    try {
      encryptedSecretOutputs = encryptSecretOutputs(msg.secretOutputs, dispatch.runPublicKey);
    } catch (err) {
      process.stderr.write(
        `[fork-runner] Failed to encrypt secret outputs: ${toErrorMessage(err)}\n`,
      );
    }
  }

  const isCancelled =
    ctx.state.forkState === 'cancelling' || ctx.state.forkState === 'force_killing';

  ctx.resolve({
    status: isCancelled ? ExecutionJobStatus.enum.cancelled : msg.status,
    stepResults: msg.stepResults,
    durationMs: Date.now() - ctx.startTime,
    ...(msg.error && { error: msg.error }),
    ...(msg.outputs && { outputs: msg.outputs }),
    ...(encryptedSecretOutputs && { secretOutputs: encryptedSecretOutputs }),
    ...(msg.droppedJobs?.length && { droppedJobs: msg.droppedJobs }),
  });

  clearAllCancelTimers(ctx);
}

/** Dispatch one IPC message from the runner. Centralises the message switch
 *  so the createForkRunner body stays small. */
function relayChildIpcMessage(
  msg: RunnerToAgentMessage,
  dispatch: JobDispatch,
  ctx: ForkRunnerCtx,
): void {
  const logDetail =
    msg.type === 'log.line'
      ? ` content="${(msg as any).line}"`
      : msg.type === 'job.complete'
        ? ` status=${(msg as any).status}`
        : '';
  process.stderr.write(`[fork-runner] IPC message received: type=${msg.type}${logDetail}\n`);

  switch (msg.type) {
    case 'ready':
      safeSendToChild(ctx.child, {
        type: 'execute',
        request: buildRequest(dispatch, ctx.effectiveWorkDir),
      });
      return;
    case 'log.line':
      ctx.execOptions.onLogLine(msg.stepIndex, msg.line);
      return;
    case 'step.start':
      ctx.stepNames.set(msg.stepIndex, msg.stepName);
      ctx.execOptions.onStepStatus(msg.stepIndex, msg.stepName, ExecutionStepStatus.enum.running);
      return;
    case 'step.complete':
      ctx.execOptions.onStepStatus(
        msg.stepIndex,
        ctx.stepNames.get(msg.stepIndex) ?? '',
        msg.status,
        {
          durationMs: msg.durationMs,
          ...(msg.error && { error: msg.error }),
          ...(msg.secretsAccessed && { secretsAccessed: msg.secretsAccessed }),
          ...(msg.step_type && { step_type: msg.step_type }),
          ...(msg.checkOutcome !== undefined && { checkOutcome: msg.checkOutcome }),
          ...(msg.driftSummary !== undefined && { driftSummary: msg.driftSummary }),
          ...(msg.drift !== undefined && { drift: msg.drift }),
          ...(msg.data && msg.data),
        },
      );
      return;
    case 'step.secret_mount':
      ctx.execOptions.onSecretMount?.({
        stepIndex: msg.stepIndex,
        sources: msg.sources,
        target: msg.target,
        kind: msg.kind,
        ...(msg.envVar !== undefined && { envVar: msg.envVar }),
      });
      return;
    case 'event.emit':
      relayEventEmit(msg as EventEmitRequest, ctx);
      return;
    case 'concurrency.report':
      relayConcurrencyReport(msg as ConcurrencyReportMessage, ctx);
      return;
    case 'agent.api.request':
      relayAgentApiRequest(msg as AgentApiRequestIpc, ctx);
      return;
    case 'cache.request':
      relayCacheRequest(msg as CacheRequestIpc, ctx);
      return;
    case 'provenance.request':
      relayProvenanceRequest(msg as ProvenanceRequestIpc, ctx);
      return;
    case 'approval.request':
      relayApprovalRequest(msg as StepApprovalRequestIpc, ctx);
      return;
    case 'job.complete':
      handleJobComplete(msg, dispatch, ctx);
      return;
  }
}

/** Resolve the result promise when the child exits without sending
 *  `job.complete` — i.e. a crash, a forced kill, or an unexpected exit. */
function handleChildExitWithoutCompletion(
  code: number | null,
  signal: NodeJS.Signals | null,
  ctx: ForkRunnerCtx,
): void {
  process.stderr.write(
    `[fork-runner] Child exited: code=${code}, signal=${signal}, jobCompleted=${ctx.state.jobCompleted}\n`,
  );
  if (ctx.state.jobCompleted) return;

  const isCancelled =
    ctx.state.forkState === 'cancelling' || ctx.state.forkState === 'force_killing';
  const crashMsg = isCancelled
    ? 'Job cancelled'
    : ctx.stderrLines.length > 0
      ? `Workflow runner crashed:\n${ctx.stderrLines.join('\n')}`
      : `Workflow runner exited unexpectedly (code=${code}, signal=${signal})`;

  if (!isCancelled) {
    ctx.execOptions.onLogLine(
      -1,
      `[sandbox] Child exited: code=${code}, signal=${signal}, stderr=${ctx.stderrLines.slice(-5).join(' | ')}`,
    );
    ctx.execOptions.onLogLine(-1, `[sandbox] ${crashMsg}`);
  }

  ctx.resolve({
    status: isCancelled ? ExecutionJobStatus.enum.cancelled : ExecutionJobStatus.enum.failed,
    stepResults: [],
    durationMs: Date.now() - ctx.startTime,
    error: isCancelled ? undefined : crashMsg,
  });

  clearAllCancelTimers(ctx);
}

/** Build the cancel function (state machine: running → cancelling →
 *  force_killing). The caller is responsible for surfacing it to the
 *  ForkRunnerHandle via the closure. */
function buildCancelFn(
  child: ChildProcess,
  ctx: ForkRunnerCtx,
  defaultGracePeriodMs: number,
  agentMaxGracePeriodMs: number,
): (force: boolean, gracePeriodMs?: number) => void {
  const doForceCancel = (): void => {
    ctx.state.forkState = 'force_killing';
    safeSendToChild(child, { type: 'abort', force: true });
    try {
      child.kill('SIGKILL');
    } catch {
      // Process may already be dead
    }
    clearAllCancelTimers(ctx);
  };

  return (force: boolean, gracePeriodMs?: number) => {
    if (ctx.state.forkState === 'force_killing') return;
    if (force || ctx.state.forkState === 'cancelling') {
      doForceCancel();
      return;
    }

    ctx.state.forkState = 'cancelling';
    safeSendToChild(child, { type: 'abort', force: false });
    try {
      child.kill('SIGTERM');
    } catch {
      // Process may already be dead
    }

    const effectiveGracePeriod = Math.min(
      gracePeriodMs ?? defaultGracePeriodMs,
      agentMaxGracePeriodMs,
    );
    const graceTimer = setTimeout(() => {
      if (ctx.state.forkState === 'cancelling') {
        process.stderr.write(
          `[fork-runner] Grace period expired (${effectiveGracePeriod}ms), escalating to SIGKILL\n`,
        );
        doForceCancel();
      }
    }, effectiveGracePeriod);
    ctx.cancelTimers.push(graceTimer);
  };
}

/**
 * Spawn the workflow runner as a child process with IPC channel.
 *
 * In non-bwrap mode: uses child_process.fork() which sets up a native IPC channel.
 * In bwrap mode: uses child_process.spawn('bwrap', ...) with stdio IPC fd.
 */
export function createForkRunner(
  options: ForkRunnerOptions,
  execOptions: JobExecutionOptions,
): ForkRunnerHandle {
  const sanitizedEnv = buildSanitizedEnv(options.env);
  // bwrap mounts a fresh `--tmpfs /tmp`, so any host TMPDIR pointing at a
  // subdirectory of /tmp (e.g. TMPDIR=/tmp/<uid> under systemd PrivateTmp, a
  // CI runner, or a shared multi-user box) does not exist inside the sandbox.
  // os.tmpdir() would then return a non-existent path and every
  // mkdtemp(join(tmpdir(), ...)) call (git config, dep install, secret mounts)
  // fails ENOENT, failing the job before any step runs. The tmpfs root is
  // always present, so pin TMPDIR to it for the sandboxed child.
  if (options.useBwrap) {
    sanitizedEnv.TMPDIR = '/tmp';
  }
  const effectiveWorkDir = options.workDir ?? '/workspace';
  const dispatch = execOptions.dispatch;

  const { child, pidAssigned } = spawnRunnerChild(options, sanitizedEnv, effectiveWorkDir);
  if (!pidAssigned) {
    const errorMsg =
      'Failed to spawn workflow runner process (no PID assigned). ' +
      'This can happen on Windows services where IPC channels cannot be established.';
    process.stderr.write(`[fork-runner] ${errorMsg}\n`);
    const noopFn = () => {};
    return {
      child,
      result: Promise.resolve({
        status: ExecutionJobStatus.enum.failed,
        stepResults: [],
        durationMs: 0,
        error: errorMsg,
      }),
      abort: async () => {},
      kill: noopFn,
      cancel: noopFn,
    };
  }

  const stderrLines = setupChildStdioCapture(child);
  const defaultGracePeriodMs = 30_000;
  const agentMaxGracePeriodMs = options.maxGracePeriodMs ?? defaultGracePeriodMs;

  // cancelTimers + state are hoisted so the kill() handle on the returned
  // ForkRunnerHandle can clear timers synchronously without waiting for the
  // child's exit handler to fire.
  const cancelTimers: NodeJS.Timeout[] = [];
  const sharedState: { forkState: ForkState; jobCompleted: boolean } = {
    forkState: 'running',
    jobCompleted: false,
  };

  // cancelFn is assigned synchronously inside the result Promise so the handle
  // returned at the bottom of the function captures it via closure.
  let cancelFn: (force: boolean, gracePeriodMs?: number) => void = () => {};

  const result = new Promise<JobExecutionResult>((resolve) => {
    const ctx: ForkRunnerCtx = {
      child,
      execOptions,
      effectiveWorkDir,
      stepNames: new Map<number, string>(),
      startTime: Date.now(),
      resolve,
      cancelTimers,
      state: sharedState,
      stderrLines,
    };

    process.stderr.write(
      `[fork-runner] Child process spawned: pid=${child.pid}, runner=${options.runnerPath}, cwd=${effectiveWorkDir}\n`,
    );

    cancelFn = buildCancelFn(child, ctx, defaultGracePeriodMs, agentMaxGracePeriodMs);

    child.on('message', (msg: RunnerToAgentMessage) => relayChildIpcMessage(msg, dispatch, ctx));
    child.on('exit', (code, signal) => handleChildExitWithoutCompletion(code, signal, ctx));
    child.on('error', (err) => {
      if (ctx.state.jobCompleted) return;
      ctx.execOptions.onLogLine(-1, `[sandbox] Fork error: ${err.message}`);
      ctx.resolve({
        status: ExecutionJobStatus.enum.failed,
        stepResults: [],
        durationMs: Date.now() - ctx.startTime,
        error: `Fork error: ${err.message}`,
      });
    });
  });

  // Legacy abort signal handler -- delegates to graceful cancel
  const onAbort = () => cancelFn(false);
  execOptions.signal.addEventListener('abort', onAbort, { once: true });
  child.on('exit', () => execOptions.signal.removeEventListener('abort', onAbort));

  return {
    child,
    result,
    abort: async () => {
      cancelFn(false);
      await result;
    },
    kill: () => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // Process may already be dead
      }
      for (const timer of cancelTimers) clearTimeout(timer);
      cancelTimers.length = 0;
    },
    cancel: (force: boolean, gracePeriodMs?: number) => cancelFn(force, gracePeriodMs),
  };
}
