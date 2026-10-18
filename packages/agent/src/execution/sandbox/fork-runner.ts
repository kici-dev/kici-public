/**
 * Fork + IPC dispatch shared by BareMetalSandbox and FirecrackerSandbox, which
 * both run the runner via child_process.fork() (or spawn via bwrap) over a Node IPC channel.
 */

import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobDispatch, CheckMode } from '@kici-dev/engine';
import { ExecutionJobStatus, ExecutionStepStatus } from '@kici-dev/engine';
import type { JobExecutionOptions, JobExecutionResult } from './types.js';
import { createSecretMasker, type LogMasker } from './log-masker.js';
import { createDepRestoreReportRelay, type DepRestoreReportRelay } from '../dep-restore-report.js';
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
  JobExecutionRequest,
} from './ipc-protocol.js';
import { withAgentSshCapability } from './git-grant-capability.js';
import { sshCredentialNames } from './ssh-client-preflight.js';
import { buildSanitizedEnv } from './env-sanitizer.js';
import { encryptSecretOutputs } from './secret-encryption.js';
import { toErrorMessage } from '@kici-dev/shared';
import type { CloneJobReposRequest } from '../../checkout/clone-job-repos.js';

/**
 * Best-effort signal of the process group led by `pid` (a `detached` child's
 * pid is its group id). Returns 1 when signalled, 0 when the group is gone
 * (ESRCH) or the pid is invalid; members are not counted, so non-zero means
 * "reap attempted".
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): number {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return 0;
  try {
    process.kill(-pid, signal);
    return 1;
  } catch {
    // ESRCH or any other error counts as "nothing signalled".
    return 0;
  }
}

/**
 * SIGTERM the job's process group, wait a grace, then SIGKILL. Returns the
 * count of attempts that signalled a live group (0, 1, or 2); 0 when the child
 * is not detached or has no pid.
 */
export async function reapGroup(
  pid: number | undefined,
  detached: boolean,
  killFn: (p: number | undefined, s: NodeJS.Signals) => number = killProcessGroup,
  sleepMs = 2000,
): Promise<number> {
  if (!detached || pid === undefined) return 0;
  // A 0 from SIGTERM means the whole group is gone (any live member, daemons
  // included, makes the signal succeed), so skip the grace wait.
  const termed = killFn(pid, 'SIGTERM');
  if (termed === 0) return 0;
  await new Promise((r) => setTimeout(r, sleepMs));
  return termed + killFn(pid, 'SIGKILL');
}

interface ForkRunnerOptions {
  /** Absolute path to the compiled workflow-runner.js. */
  runnerPath: string;
  /** Pre-sanitized base environment (system + user vars). */
  env: Record<string, string>;
  useBwrap?: boolean;
  workDir?: string;
  /**
   * bwrap `--unshare-net`: loopback only. Deliberately strict, since bare-metal
   * is for trusted environments only. Needs useBwrap.
   */
  networkIsolation?: boolean;
  /**
   * Absolute host paths bound read-only into bwrap, e.g. `file://` clone source
   * dirs the runner's `git clone` reads. Ignored without useBwrap.
   */
  extraReadOnlyBinds?: string[];
  /** Agent cap on the grace period, ms; effective grace is min(job, this). Default 30_000. */
  maxGracePeriodMs?: number;
  /** Opt-in dedicated user (uid, `uid:gid`, or name); unset runs as the agent's uid. */
  runnerUser?: string;
  /**
   * Spawn the child `detached` as its own process-group leader, so the
   * between-jobs phase can reap a daemon reparented to init. Set by bare-metal
   * with orphan cleanup on and bwrap off; ignored under bwrap, whose PID
   * namespace already contains the tree.
   */
  detachProcessGroup?: boolean;
  /** Out-of-band re-run in the preserved workdir of only the declared cleanup / onFailure hooks. */
  cleanupOnly?: boolean;
}

/**
 * Cancel state machine; prevents races between force-cancel and hook completion.
 * - cancelling: SIGTERM sent, hooks may be running
 * - force_killing: SIGKILL sent, no hooks
 */
type ForkState = 'running' | 'cancelling' | 'force_killing';

export interface ForkRunnerHandle {
  child: ChildProcess;
  result: Promise<JobExecutionResult>;
  /** SIGTERM -> SIGKILL. Legacy; prefer cancel(). */
  abort: () => Promise<void>;
  kill: () => void;
  /**
   * @param force false: SIGTERM, grace period, then SIGKILL. true: SIGKILL now, skip hooks.
   * @param gracePeriodMs Graceful only; capped by the agent's maxGracePeriodMs.
   */
  cancel: (force: boolean, gracePeriodMs?: number) => void;
  /** Leads its own process group (bare-metal, non-bwrap, orphan cleanup on); gates `reap()`. */
  detached: boolean;
  /**
   * Set by `completion-hooks-done`. False when the child exits before it, which
   * cues the between-jobs phase to re-run declared cleanup out-of-band.
   */
  completionHooksRan: boolean;
  /**
   * Set by `hooks-declared` when the job has an `onFailure` / `cleanup` hook.
   * Recorded early so it survives a hard kill; gates the out-of-band re-run.
   */
  declaresCleanup: boolean;
  /** {@link reapGroup} over the runner's process group, reaping any daemon it backgrounded. */
  reap: () => Promise<number>;
}

/**
 * The clone-relevant slice of a dispatch: source repo and credentials from the
 * envelope, workflow repo and checkout switches from `jobConfig`. The runner's
 * request and the agent's host-side checkout both use this one reader, so the
 * two clones cannot read different fields.
 */
export function buildCloneRequest(
  dispatch: JobDispatch,
  extra?: { credentialHelperPath?: string | undefined },
): CloneJobReposRequest {
  const jobConfig = dispatch.jobConfig as Record<string, unknown>;
  return {
    repoUrl: dispatch.repoUrl,
    ref: dispatch.ref,
    sha: dispatch.sha,
    sourceAuth: dispatch.sourceAuth,
    workflowAuth: dispatch.workflowAuth,
    ...(extra?.credentialHelperPath ? { credentialHelperPath: extra.credentialHelperPath } : {}),
    workflowRepoUrl: jobConfig.workflowRepoUrl as string | undefined,
    workflowRef: jobConfig.workflowRef as string | undefined,
    workflowSha: jobConfig.workflowSha as string | undefined,
    checkout: (jobConfig.checkout as boolean | undefined) ?? true,
    fullRepo: (jobConfig.fullRepo as boolean | undefined) ?? false,
  };
}

/** `sshGitCredentials` for a host-path job that declares any; nothing otherwise. */
function sshCredentialsFor(
  jobConfig: Record<string, unknown>,
  credentialHelperPath: string | undefined,
): { sshGitCredentials?: string[] } {
  if (!credentialHelperPath) return {};
  const names = sshCredentialNames(jobConfig.gitCredentials);
  return names.length > 0 ? { sshGitCredentials: names } : {};
}

/** Map a JobDispatch to the subset the workflow runner needs. */
export function buildRequest(
  dispatch: JobDispatch,
  workDir: string,
  extra?: {
    cleanupOnly?: boolean;
    credentialHelperPath?: string;
    allowInstallScripts?: boolean;
  },
): JobExecutionRequest {
  const jobConfig = dispatch.jobConfig as Record<string, unknown>;

  return {
    ...(extra?.cleanupOnly ? { cleanupOnly: true } : {}),
    runId: dispatch.runId,
    jobId: dispatch.jobId,
    workDir,
    ...buildCloneRequest(dispatch, extra),
    ...sshCredentialsFor(jobConfig, extra?.credentialHelperPath),
    ...(extra?.allowInstallScripts ? { allowInstallScripts: true } : {}),
    sourceTarUrl: dispatch.sourceTarUrl,
    sourceTarDigest: dispatch.sourceTarDigest,
    depsUrl: dispatch.depsUrl,
    depsHash: dispatch.depsHash,

    workflowName: (jobConfig.workflowName as string) ?? '',
    // jobConfig.name is the expanded child name used for reporting; the source
    // defines the job under baseJobName, which findJob/extractSteps + ctx.job.name need.
    jobName: (jobConfig.baseJobName as string | undefined) ?? (jobConfig.name as string) ?? '',
    runsOn: (jobConfig.runsOn as string) ?? '',
    matrixValues: jobConfig.matrixValues as Record<string, unknown> | undefined,
    host: jobConfig.host as string | undefined,
    agent: jobConfig.agent as
      { host: string; labels: string[]; platform?: string; arch?: string } | undefined,
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
    isTestRun: (jobConfig.isTestRun as boolean | undefined) ?? false,
    checkMode: jobConfig.checkMode as CheckMode | undefined,

    tarballUrl: jobConfig.tarballUrl as string | undefined,
    cliPublicKey: jobConfig.cliPublicKey as string | undefined,
    orchestratorPrivateKey: jobConfig.orchestratorPrivateKey as string | undefined,

    runPublicKey: dispatch.runPublicKey,
    // Server truth for a deferred attestation's frozen statement: read from the
    // dispatch, never job config, so the job cannot influence it.
    provenanceContext: dispatch.provenanceContext,

    context: jobConfig.context as string | undefined,
    contextVars: jobConfig.contextVars as Record<string, string> | undefined,
    jobEnv: jobConfig.jobEnv as Record<string, string> | undefined,

    isGlobalWorkflow: jobConfig.isGlobalWorkflow as boolean | undefined,
    workflowRepoIdentifier: jobConfig.workflowRepoIdentifier as string | undefined,

    hasConcurrencyGroup: (jobConfig.hasConcurrencyGroup as boolean | undefined) ?? false,
    concurrencyEvaluationTimeoutMs: jobConfig.concurrencyEvaluationTimeoutMs as number | undefined,
    concurrencyWaitTimeoutMs: dispatch.concurrencyWaitTimeoutMs,
    branch: dispatch.ref,

    // For ctx.jobOutputs().
    upstreamJobOutputs: dispatch.upstreamJobOutputs as
      Record<string, Record<string, unknown>> | undefined,

    // Shape ctx.needs for steps.
    upstreamJobStatuses: dispatch.upstreamJobStatuses as
      Record<string, import('@kici-dev/engine').ExecutionJobStatus> | undefined,
    jobNeeds: jobConfig.needs as readonly unknown[] | undefined,

    // For a downstream job's ctx.needs['<gate>'].result.
    upstreamInvokeResults: dispatch.upstreamInvokeResults as
      Record<string, import('@kici-dev/engine').InvokeResult[]> | undefined,

    // Private-registry install auth.
    npmRegistries: dispatch.npmRegistries,
    installEnvSecrets: dispatch.installEnvSecrets,
    jobIdShort: dispatch.jobId.slice(0, 8),

    // Re-evaluated to extract a DynamicJobFn's step functions.
    dynamicSource: jobConfig.dynamicSource as
      { index: number; event: Record<string, unknown>; expectedJobNames?: string[] } | undefined,
  };
}

/**
 * bwrap args: read-only system dirs and Node install, writable workspace,
 * private /dev /proc /tmp, PID + IPC namespaces, die-with-parent, new-session.
 *
 * networkIsolation adds --unshare-net (loopback only). Full isolation is
 * deliberate: bare-metal is for trusted environments only, and it is simpler
 * and more secure than selective blocking.
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

  if (networkIsolation) {
    args.push('--unshare-net');
  }

  // /lib64 (absent on most arm64) holds the x86_64 loader (ld-linux-x86-64.so.2).
  if (existsSync('/lib64')) {
    // libIdx is the '/lib' source arg; +2 lands past the target. At +1, bwrap
    // reads the stray '/lib64' as the exec command (`execvp /lib64: No such file`).
    const libIdx = args.indexOf('/lib', args.indexOf('--ro-bind') + 1);
    if (libIdx !== -1) {
      args.splice(libIdx + 2, 0, '--ro-bind', '/lib64', '/lib64');
    }
  }

  // bwrap's /etc holds ONLY explicitly bound files, so without these an
  // /etc/hosts-only name (e.g. registry.local for `npm install` under
  // KICI_SANDBOX_NETWORK=host) silently resolves via mDNS/DNS to another host.
  // nsswitch.conf pins files-first order; each is guarded since a minimal host may lack it.
  for (const nssFile of ['/etc/hosts', '/etc/nsswitch.conf']) {
    if (existsSync(nssFile)) {
      args.push('--ro-bind', nssFile, nssFile);
    }
  }

  // Bind the Node install ROOT (nvm/mise/asdf may live outside /usr), not just
  // bin/: npm lives at $NODE_ROOT/lib/node_modules/npm, and `installDeps` fails
  // with `Cannot find module '.../npm-cli.js'` without it.
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
    // The root is `/` or under /usr or /bin: bind just the binary's dir.
    args.push('--ro-bind', nodeDir, nodeDir);
  }

  // Make workflow-runner.js and its deps reachable at their real paths.
  // - pnpm workspace (source checkout): bind the whole workspace root, since
  //   symlinked node_modules point at sibling packages; binding only the runner
  //   dir fails with `Cannot find package '@kici-dev/shared'`.
  // - Single tree (tarball or bundled binary, no pnpm-workspace.yaml): bind
  //   runnerDir plus every node_modules up its parent chain.
  const boundDirs = new Set<string>();
  if (runnerPath) {
    const runnerDir = dirname(runnerPath);

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
      args.push('--ro-bind', workspaceRoot, workspaceRoot);
      boundDirs.add(workspaceRoot);
    } else {
      // Skip the runner bind when the node install root covers it (single-binary distributions).
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

  // Caller binds, e.g. file:// clone sources (see fileCloneSourceBinds).
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
 * Read-only bind path(s) for a `file://` clone source: the runner clones inside
 * the sandbox, so without the bind `git clone` fails with `does not appear to be
 * a git repository`. Returns `[]` for non-`file://` remotes and for a malformed
 * `file://` URL (the clone then surfaces the real error).
 *
 * Bare-metal feeds it to `buildBwrapArgs`'s `extraReadOnlyBinds`; the container
 * backend binds each as `<dir>:<dir>:ro`.
 */
export function fileCloneSourceBinds(repoUrl: string | undefined): string[] {
  if (typeof repoUrl !== 'string' || !repoUrl.startsWith('file://')) return [];
  try {
    const url = new URL(repoUrl);
    // Binding `/` would expose the entire host root.
    return url.pathname && url.pathname !== '/' ? [url.pathname] : [];
  } catch {
    return [];
  }
}

export interface RunnerIdentity {
  uid: number;
  gid: number;
}

/**
 * Resolve a `KICI_RUNNER_USER` spec (`uid`, `uid:gid`, or a name, via `id`) to
 * numeric ids; a missing gid takes the user's primary group.
 *
 * Throws rather than falling back to the agent's uid: the operator asked for a
 * boundary, and silently lacking one is the worst outcome.
 */
export function resolveRunnerUser(spec: string | undefined): RunnerIdentity | undefined {
  if (!spec) return undefined;

  const [userPart, groupPart] = spec.split(':');
  const runId = (args: string[]): string => {
    const out = execFileSync('id', args, { encoding: 'utf8' }).trim();
    if (!out) throw new Error(`empty output from \`id ${args.join(' ')}\``);
    return out;
  };

  try {
    const uid = /^\d+$/.test(userPart ?? '') ? Number(userPart) : Number(runId(['-u', userPart!]));
    const gid =
      groupPart === undefined
        ? Number(runId(['-g', userPart!]))
        : /^\d+$/.test(groupPart)
          ? Number(groupPart)
          : Number(runId(['-g', groupPart]));
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
      throw new Error('non-numeric id');
    }
    return { uid, gid };
  } catch (err) {
    throw new Error(
      `KICI_RUNNER_USER='${spec}' could not be resolved to a uid/gid: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Chown the job workdir to the runner user so the child can write it. Failure
 * is fatal: a dedicated uid that cannot write is a broken job posing as a boundary.
 */
function chownWorkDirToRunner(workDir: string, identity: RunnerIdentity): void {
  if (!workDir) return;
  try {
    execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, workDir], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `failed to chown job workdir ${workDir} to ${identity.uid}:${identity.gid} ` +
        `for KICI_RUNNER_USER: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Spawn the runner child. Under Windows services (shawl) fork() can fail
 * silently when IPC pipes cannot be set up; the caller treats
 * `pidAssigned=false` as an immediate failure.
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

  // Applied under bwrap too: its namespaces do not change the uid, so the child
  // could still reach the agent process outside the namespace.
  const identity = resolveRunnerUser(options.runnerUser);
  if (identity) chownWorkDirToRunner(effectiveWorkDir, identity);
  const identityOpts = identity ? { uid: identity.uid, gid: identity.gid } : {};

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
      ...identityOpts,
    });
  } else {
    child = fork(runnerPath, [], {
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: effectiveWorkDir || undefined,
      // Own process group so the between-jobs reap can signal the whole tree.
      // Keep the IPC channel + pipes; never .unref() (the supervisor awaits exit).
      detached: options.detachProcessGroup === true,
      ...identityOpts,
    });
  }
  return { child, pidAssigned: Boolean(child.pid) };
}

/**
 * `KICI_RUNNER_DEBUG_STDIO=true` echoes the child's raw stdio to the agent's stderr.
 *
 * Off by default: for a scaler-spawned agent, the orchestrator's LogForwarder
 * copies agent stderr into journald and Loki, readable without the `runs:read`
 * check and with no per-org scoping, so the echo would publish an unmasked copy
 * of the masked `log.line` stream.
 *
 * Read per call, not cached, so a test can flip it between cases.
 */
function debugStdioEnabled(): boolean {
  return process.env.KICI_RUNNER_DEBUG_STDIO === 'true';
}

/** Drain stdout (a full pipe blocks the child) and keep the last stderr lines
 *  for crash diagnostics in the returned array, which the listener mutates in place. */
function setupChildStdioCapture(child: ChildProcess): string[] {
  const stderrLines: string[] = [];
  const MAX_STDERR_LINES = 20;

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (debugStdioEnabled()) {
        process.stderr.write(`[workflow-runner:stdout] ${chunk.toString().trimEnd()}\n`);
      }
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
        // The crash tail is masked before emission; only the echo is gated.
        stderrLines.push(line);
        if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
        if (debugStdioEnabled()) {
          process.stderr.write(`[workflow-runner:stderr] ${line}\n`);
        }
      }
    });
  }

  return stderrLines;
}

/** Swallows EPIPE / closed-channel errors: the channel may close before a relay responds. */
function safeSendToChild(child: ChildProcess, msg: AgentToRunnerMessage): void {
  try {
    child.send(msg);
  } catch {
    // IPC channel may be closed if runner already exited
  }
}

/** State shared by the message, exit and error handlers. Mutable fields live
 *  on the object so helpers update them in place and the closure sees the current value. */
interface ForkRunnerCtx {
  child: ChildProcess;
  execOptions: JobExecutionOptions;
  effectiveWorkDir: string;
  stepNames: Map<number, string>;
  startTime: number;
  resolve: (result: JobExecutionResult) => void;
  cancelTimers: NodeJS.Timeout[];
  state: {
    forkState: ForkState;
    jobCompleted: boolean;
    completionHooksRan: boolean;
    declaresCleanup: boolean;
  };
  stderrLines: string[];
  /**
   * Masks the crash tail, which is built here from the child's raw stderr where
   * the child's own masker cannot reach.
   */
  masker: LogMasker;
  cleanupOnly: boolean;
  depRestoreRelay: DepRestoreReportRelay;
}

function clearAllCancelTimers(ctx: ForkRunnerCtx): void {
  for (const timer of ctx.cancelTimers) clearTimeout(timer);
  ctx.cancelTimers.length = 0;
}

/** Relay `event.emit` and send the response (or an error response) back to the runner. */
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

/** Relay `concurrency.report`; a relay failure answers with a synthetic cancel ack. */
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

/** Relay `agent.api.request`; errors and a missing callback answer with an error response. */
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

/** Relay `cache.request`; errors and a missing callback answer with an error response. */
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

/** Relay `git.grant.request` to the agent's grant table; errors and a missing
 *  callback answer with an error response. */
function relayGitGrantRequest(msg: GitGrantRequestIpc, ctx: ForkRunnerCtx): void {
  if (!ctx.execOptions.onGitGrantRequest) {
    safeSendToChild(ctx.child, {
      type: 'git.grant.response',
      requestId: msg.requestId,
      error: 'Git credentials are not available in this agent configuration',
    });
    return;
  }
  const request = withAgentSshCapability(msg, Boolean(ctx.execOptions.credentialHelperPath));
  ctx.execOptions.onGitGrantRequest(request).then(
    (response) => safeSendToChild(ctx.child, response),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'git.grant.response',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}
/** Relay `provenance.request`; errors and a missing callback answer with an error response. */
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

/** Relay `artifacts.request`; errors and a missing callback answer with an error response. */
function relayArtifactRequest(msg: ArtifactRequestIpc, ctx: ForkRunnerCtx): void {
  if (!ctx.execOptions.onArtifactRequest) {
    safeSendToChild(ctx.child, {
      type: 'artifacts.response',
      requestId: msg.requestId,
      error: 'Artifacts not available in this agent configuration',
    });
    return;
  }
  ctx.execOptions.onArtifactRequest(msg).then(
    (response) => safeSendToChild(ctx.child, response),
    (err) =>
      safeSendToChild(ctx.child, {
        type: 'artifacts.response',
        requestId: msg.requestId,
        error: toErrorMessage(err),
      }),
  );
}

/** Relay `approval.request`; a missing callback or a relay error fails closed with a reject. */
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

/** Resolve on `job.complete`: encrypt secret outputs when a runPublicKey exists,
 *  and report `cancelled` if a cancel was already in flight. */
function handleJobComplete(
  msg: Extract<RunnerToAgentMessage, { type: 'job.complete' }>,
  dispatch: JobDispatch,
  ctx: ForkRunnerCtx,
): void {
  ctx.state.jobCompleted = true;

  let encryptedSecretOutputs:
    Record<string, { agentPublicKey: string; encrypted: string }> | undefined;
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

/** Dispatch one IPC message from the runner. */
function relayChildIpcMessage(
  msg: RunnerToAgentMessage,
  dispatch: JobDispatch,
  ctx: ForkRunnerCtx,
): void {
  // Line content is job output bound for the run log; echoing it to stderr
  // would copy it into the orchestrator's journal, so it shares the debug gate.
  const logDetail =
    msg.type === 'log.line'
      ? debugStdioEnabled()
        ? ` content="${(msg as any).line}"`
        : ''
      : msg.type === 'job.complete'
        ? ` status=${(msg as any).status}`
        : '';
  process.stderr.write(`[fork-runner] IPC message received: type=${msg.type}${logDetail}\n`);

  switch (msg.type) {
    case 'ready':
      safeSendToChild(ctx.child, {
        type: 'execute',
        request: buildRequest(dispatch, ctx.effectiveWorkDir, {
          cleanupOnly: ctx.cleanupOnly,
          credentialHelperPath: ctx.execOptions.credentialHelperPath,
          allowInstallScripts: ctx.execOptions.allowInstallScripts,
        }),
      });
      return;
    case 'log.line':
      ctx.execOptions.onLogLine(msg.stepIndex, msg.line, msg.stream);
      return;
    case 'dep-restore.report':
      ctx.depRestoreRelay.relay(msg.report);
      return;
    case 'step.start': {
      ctx.depRestoreRelay.onStepStarted();
      ctx.stepNames.set(msg.stepIndex, msg.stepName);
      const startState =
        msg.state === 'pending'
          ? ExecutionStepStatus.enum.pending
          : ExecutionStepStatus.enum.running;
      const startData = {
        ...(msg.concurrencyKind && { concurrencyKind: msg.concurrencyKind }),
        ...(msg.groupId && { groupId: msg.groupId }),
        // Typed from the start, so a running init or hook step is placed by its type.
        ...(msg.step_type && { step_type: msg.step_type }),
      };
      if (Object.keys(startData).length > 0) {
        ctx.execOptions.onStepStatus(msg.stepIndex, msg.stepName, startState, startData);
      } else {
        ctx.execOptions.onStepStatus(msg.stepIndex, msg.stepName, startState);
      }
      return;
    }
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
          ...(msg.concurrencyKind && { concurrencyKind: msg.concurrencyKind }),
          ...(msg.groupId && { groupId: msg.groupId }),
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
    case 'git.grant.request':
      relayGitGrantRequest(msg as GitGrantRequestIpc, ctx);
      return;
    case 'cache.request':
      relayCacheRequest(msg as CacheRequestIpc, ctx);
      return;
    case 'artifacts.request':
      relayArtifactRequest(msg as ArtifactRequestIpc, ctx);
      return;
    case 'provenance.request':
      relayProvenanceRequest(msg as ProvenanceRequestIpc, ctx);
      return;
    case 'approval.request':
      relayApprovalRequest(msg as StepApprovalRequestIpc, ctx);
      return;
    case 'hooks-declared':
      ctx.state.declaresCleanup = msg.declaresCleanup;
      return;
    case 'completion-hooks-done':
      ctx.state.completionHooksRan = true;
      return;
    case 'job.complete':
      handleJobComplete(msg, dispatch, ctx);
      return;
  }
}

/** Resolve when the child exits without `job.complete`: a crash, a forced kill,
 *  or an unexpected exit. */
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
  // Raw stderr never passed the child's masker; mask before the run log and persisted error.
  const stderrLines = ctx.stderrLines.map((line) => ctx.masker.mask(line));
  const crashMsg = isCancelled
    ? 'Job cancelled'
    : stderrLines.length > 0
      ? `Workflow runner crashed:\n${stderrLines.join('\n')}`
      : `Workflow runner exited unexpectedly (code=${code}, signal=${signal})`;

  if (!isCancelled) {
    ctx.execOptions.onLogLine(
      -1,
      `[sandbox] Child exited: code=${code}, signal=${signal}, stderr=${stderrLines.slice(-5).join(' | ')}`,
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

/** Cancel function over the running → cancelling → force_killing state machine. */
function buildCancelFn(
  child: ChildProcess,
  ctx: ForkRunnerCtx,
  defaultGracePeriodMs: number,
  agentMaxGracePeriodMs: number,
  detached: boolean,
): (force: boolean, gracePeriodMs?: number) => void {
  const doForceCancel = (): void => {
    ctx.state.forkState = 'force_killing';
    safeSendToChild(child, { type: 'abort', force: true });
    try {
      child.kill('SIGKILL');
    } catch {
      // Process may already be dead
    }
    // Kill the group so backgrounded daemons die now; the later reap() is idempotent.
    if (detached) killProcessGroup(child.pid, 'SIGKILL');
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
 * Spawn the workflow runner with an IPC channel: fork() natively, or
 * spawn('bwrap', ...) with a stdio IPC fd under bwrap.
 */
export function createForkRunner(
  options: ForkRunnerOptions,
  execOptions: JobExecutionOptions,
): ForkRunnerHandle {
  const sanitizedEnv = buildSanitizedEnv(options.env);
  // bwrap's fresh `--tmpfs /tmp` lacks any host TMPDIR subdirectory (e.g.
  // /tmp/<uid> under PrivateTmp), so every mkdtemp(tmpdir()) would fail ENOENT
  // before any step runs. The tmpfs root always exists.
  if (options.useBwrap) {
    sanitizedEnv.TMPDIR = '/tmp';
  }
  // buildSanitizedEnv strips KICI_*; restore this flag so it gates the child's
  // fork-mode stdout passthrough as well as the agent-side drain.
  if (debugStdioEnabled()) {
    sanitizedEnv.KICI_RUNNER_DEBUG_STDIO = 'true';
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
      detached: false,
      completionHooksRan: false,
      declaresCleanup: false,
      reap: async () => 0,
    };
  }

  const stderrLines = setupChildStdioCapture(child);
  const defaultGracePeriodMs = 30_000;
  const agentMaxGracePeriodMs = options.maxGracePeriodMs ?? defaultGracePeriodMs;

  // Hoisted so kill() can clear timers synchronously, before the exit handler fires.
  const cancelTimers: NodeJS.Timeout[] = [];
  const detached = options.detachProcessGroup === true;
  const sharedState: {
    forkState: ForkState;
    jobCompleted: boolean;
    completionHooksRan: boolean;
    declaresCleanup: boolean;
  } = {
    forkState: 'running',
    jobCompleted: false,
    completionHooksRan: false,
    declaresCleanup: false,
  };

  // Assigned synchronously inside the result Promise executor.
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
      masker: createSecretMasker(
        buildRequest(dispatch, effectiveWorkDir, {
          cleanupOnly: options.cleanupOnly === true,
          credentialHelperPath: execOptions.credentialHelperPath,
        }),
      ),
      cleanupOnly: options.cleanupOnly === true,
      depRestoreRelay: createDepRestoreReportRelay(dispatch.jobId),
    };

    process.stderr.write(
      `[fork-runner] Child process spawned: pid=${child.pid}, runner=${options.runnerPath}, cwd=${effectiveWorkDir}\n`,
    );

    cancelFn = buildCancelFn(child, ctx, defaultGracePeriodMs, agentMaxGracePeriodMs, detached);

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

  // Legacy abort signal: graceful cancel.
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
    detached,
    get completionHooksRan() {
      return sharedState.completionHooksRan;
    },
    get declaresCleanup() {
      return sharedState.declaresCleanup;
    },
    reap: () => reapGroup(child.pid, detached),
  };
}
