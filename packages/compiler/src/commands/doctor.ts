/**
 * kici doctor — walk the onboarding funnel; each check reports pass/warn/fail
 * with the exact next command. Inputs: the stored config, the run target (one
 * `whoami` read for a direct orchestrator target), one authenticated Platform
 * infrastructure read, and local filesystem/git state.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import {
  deriveDiagnoseOverall,
  diagnoseExitCode,
  toErrorMessage,
  type DiagnoseResponse,
  type DiagnoseResult,
} from '@kici-dev/core';
import {
  canonicalizeLabelSet,
  canonicalizeMatcher,
  formatLabelMatchers,
  matcherSatisfiedBy,
  type DiagnosticsInfrastructureResponse,
  type LabelMatcher,
} from '@kici-dev/engine';
import { loadGlobalConfig, type GlobalConfig } from '../remote/config.js';
import {
  DirectApiUnavailableError,
  DirectRunClient,
  type DirectWhoami,
} from '../remote/direct-client.js';
import { AuthenticationError, ConnectionError } from '../remote/platform-client.js';
import { resolveRunTarget, type RunTargetResolution } from '../remote/target.js';
import { resolveKiciDir } from '../execution/index.js';
import {
  MISSING_KICI_MANIFEST_FIX,
  MISSING_KICI_MANIFEST_MESSAGE,
  kiciDirNeedsManifest,
} from './agent-deps-preflight.js';
import {
  DashboardClient,
  DashboardClientError,
  type DashboardErrorKind,
} from '../remote/dashboard-client.js';
import { isLockStaticJob, type LockFile } from '../types.js';

const execFileAsync = promisify(execFile);

export interface DoctorCheckResult extends DiagnoseResult {
  nextCommand?: string;
}

/** A check before the runner stamps its duration. */
export type DoctorCheckBody = Omit<DoctorCheckResult, 'durationMs'>;

export type ProbeOutcome =
  | { ok: true; infra: DiagnosticsInfrastructureResponse }
  | { ok: false; kind: DashboardErrorKind; message: string };

type DirectProbe =
  | { ok: true; whoami: DirectWhoami }
  | { ok: false; kind: 'auth' | 'unreachable' | 'unavailable' | 'error'; message: string };

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DIRECT_SOURCE_LABEL: Record<'flag' | 'env' | 'saved', string> = {
  flag: '--orchestrator-url',
  env: 'KICI_ORCHESTRATOR_TOKEN',
  saved: 'kici connect',
};

/** Where `kici run remote` sends a run, and whether a direct target answers. */
function checkRunTarget(
  resolution: RunTargetResolution,
  probe: DirectProbe | null,
): DoctorCheckBody {
  const name = 'run-target';
  if (!resolution.ok) {
    return {
      name,
      status: 'fail',
      message: resolution.error,
      nextCommand: 'kici connect <url>  (or kici login)',
    };
  }
  const target = resolution.target;
  if (target.kind === 'platform') {
    return { name, status: 'pass', message: `Platform login (${target.endpoint}).` };
  }
  const where = `Orchestrator ${target.url} (from ${DIRECT_SOURCE_LABEL[target.source]})`;
  if (!probe || !probe.ok) {
    const message = probe?.message ?? 'not checked';
    return {
      name,
      status: 'fail',
      message: `${where}: ${message}`,
      ...(probe?.kind === 'auth' && { nextCommand: `kici connect ${target.url}` }),
    };
  }
  const me = probe.whoami;
  const who = `${me.subject ?? me.label}, role ${me.role}, ${me.mode} mode`;
  if (!me.permissions.trigger) {
    return {
      name,
      status: 'warn',
      message: `${where} as ${who}: this token can follow runs, cannot start them.`,
      nextCommand: `kici connect ${target.url}`,
    };
  }
  return { name, status: 'pass', message: `${where} as ${who}.` };
}

function checkDeprecatedConfig(config: GlobalConfig): DoctorCheckBody | null {
  if (config.routingKey === undefined) return null;
  return {
    name: 'config',
    status: 'warn',
    message:
      'The routingKey field in ~/.kici/config is deprecated and unused; delete it (removed in v1.0.0).',
  };
}

/** A warning row when `.kici/` cannot run on an agent, or null when it can. */
function checkAgentDeps(needsManifest: boolean): DoctorCheckBody | null {
  if (!needsManifest) return null;
  return {
    name: 'agent-deps',
    status: 'warn',
    message: MISSING_KICI_MANIFEST_MESSAGE,
    nextCommand: MISSING_KICI_MANIFEST_FIX,
  };
}

/** Regardless of expiry. */
export function hasCredentials(config: GlobalConfig): boolean {
  return Boolean(config.pat && config.platformEndpoint);
}

/** Logged in with an unexpired token. */
export function checkLogin(config: GlobalConfig, now: number): DoctorCheckBody {
  const name = 'login';
  const endpoint = config.platformEndpoint;
  if (!hasCredentials(config)) {
    return {
      name,
      status: 'fail',
      message: 'Not logged in (no stored credentials).',
      nextCommand: 'kici login',
    };
  }
  if (config.patExpiresAt) {
    const expiresAt = Date.parse(config.patExpiresAt);
    if (!Number.isNaN(expiresAt)) {
      if (expiresAt <= now) {
        return {
          name,
          status: 'fail',
          message: 'Access token has expired.',
          nextCommand: 'kici login',
        };
      }
      if (expiresAt - now < SEVEN_DAYS_MS) {
        const days = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
        return {
          name,
          status: 'warn',
          message: `Access token expires in ${days} day(s).`,
          nextCommand: 'kici login',
        };
      }
    }
  }
  return { name, status: 'pass', message: `Logged in to ${endpoint}.` };
}

export function checkActiveOrg(config: GlobalConfig): DoctorCheckBody {
  const name = 'active-org';
  if (!config.activeOrgId) {
    return {
      name,
      status: 'fail',
      message: 'No active organization selected.',
      nextCommand: 'kici org use <name>',
    };
  }
  return { name, status: 'pass', message: `Active organization: ${config.activeOrgId}.` };
}

export function checkLiveToken(probe: ProbeOutcome | null): DoctorCheckBody {
  const name = 'token-live';
  if (probe === null) {
    return {
      name,
      status: 'warn',
      message: 'Skipped: requires login and an active organization.',
    };
  }
  if (probe.ok) {
    return { name, status: 'pass', message: 'Platform accepted the access token.' };
  }
  if (probe.kind === 'unauthorized' || probe.kind === 'not_logged_in') {
    return {
      name,
      status: 'fail',
      message: `Authentication failed: ${probe.message}`,
      nextCommand: 'kici login',
    };
  }
  return { name, status: 'warn', message: `Could not verify token: ${probe.message}` };
}

export interface LockState {
  exists: boolean;
  fresh: boolean; // lock mtime >= newest workflow-source mtime
  committed: boolean; // working tree clean for the lock path
  gitAvailable: boolean; // false outside a git repo
  lock: LockFile | null;
}

export function checkOrchestrator(probe: ProbeOutcome | null): DoctorCheckBody {
  const name = 'orchestrator';
  if (probe === null || !probe.ok) {
    return { name, status: 'warn', message: 'Skipped: Platform not reachable (see token-live).' };
  }
  const orchestrators = probe.infra.orchestrators ?? [];
  const connected = orchestrators.filter((o) => o.connected);
  if (orchestrators.length === 0) {
    return {
      name,
      status: 'warn',
      message: 'No orchestrator has connected for this organization yet.',
      nextCommand: 'kici diagnostics',
    };
  }
  if (connected.length === 0) {
    return {
      name,
      status: 'fail',
      message: `${orchestrators.length} orchestrator(s) registered but none are currently connected.`,
      nextCommand: 'kici diagnostics',
    };
  }
  return { name, status: 'pass', message: `${connected.length} orchestrator(s) connected.` };
}

export function checkLockFile(state: LockState): DoctorCheckBody {
  const name = 'lock-file';
  if (!state.exists) {
    return {
      name,
      status: 'fail',
      message: 'No compiled kici.lock.json found.',
      nextCommand: 'kici compile',
    };
  }
  if (!state.fresh) {
    return {
      name,
      status: 'warn',
      message: 'Lock file is stale — workflow sources changed since the last compile.',
      nextCommand: 'kici compile',
    };
  }
  if (state.gitAvailable && !state.committed) {
    return {
      name,
      status: 'warn',
      message: 'Lock file has uncommitted changes.',
      nextCommand: 'git add .kici/kici.lock.json && git commit',
    };
  }
  return { name, status: 'pass', message: 'Lock file present, fresh, and committed.' };
}

interface LabelRequirement {
  runsOn: readonly LabelMatcher[];
  exclude: readonly LabelMatcher[];
}

/**
 * Same rule as the orchestrator's job queue: EVERY runsOn matcher and NONE of
 * the excludeLabels. Both sides are case-folded: the probe reports canonical
 * labels while lock matchers keep the author's case, so a raw compare would
 * call a dispatchable job unreachable and let an excluded label slip past.
 */
function requirementSatisfiedBy(req: LabelRequirement, labels: ReadonlySet<string>): boolean {
  const canonical = canonicalizeLabelSet([...labels]);
  return (
    req.runsOn.every((m) => matcherSatisfiedBy(canonicalizeMatcher(m), canonical)) &&
    !req.exclude.some((m) => matcherSatisfiedBy(canonicalizeMatcher(m), canonical))
  );
}

function describeRequirement(req: LabelRequirement): string {
  const base = formatLabelMatchers(req.runsOn, ' + ');
  return req.exclude.length > 0 ? `${base} − ${formatLabelMatchers(req.exclude)}` : base;
}

/**
 * Groups that can satisfy a runsOn set alone: each connected agent's labels and
 * each scaler labelSet.
 */
function availableLabelGroups(infra: DiagnosticsInfrastructureResponse): Set<string>[] {
  const groups: Set<string>[] = [];
  for (const o of infra.orchestrators) {
    if (!o.connected) continue;
    for (const a of o.agents ?? []) groups.push(new Set(a.labels ?? []));
    for (const s of o.scalers ?? []) for (const set of s.labelSets ?? []) groups.push(new Set(set));
  }
  return groups;
}

export function checkLabels(lock: LockFile | null, probe: ProbeOutcome | null): DoctorCheckBody {
  const name = 'labels';
  if (!lock) {
    return { name, status: 'warn', message: 'Skipped: no compiled lock file to read labels from.' };
  }
  if (probe === null || !probe.ok) {
    return { name, status: 'warn', message: 'Skipped: Platform not reachable (see token-live).' };
  }
  const required: LabelRequirement[] = [];
  for (const wf of lock.workflows) {
    for (const job of wf.jobs) {
      if (!isLockStaticJob(job)) continue; // dynamic-job factories target at agent runtime
      const runsOn = job.runsOn ?? [];
      if (runsOn.length === 0) continue;
      required.push({ runsOn, exclude: job.excludeLabels ?? [] });
    }
  }
  if (required.length === 0) {
    return { name, status: 'pass', message: 'No workflow label constraints to satisfy.' };
  }
  const groups = availableLabelGroups(probe.infra);
  if (groups.length === 0) {
    return {
      name,
      status: 'warn',
      message: 'No connected agents or scalers to satisfy any workflow labels.',
      nextCommand: 'kici diagnostics',
    };
  }
  const unsatisfied = new Set<string>();
  for (const req of required) {
    if (!groups.some((labels) => requirementSatisfiedBy(req, labels))) {
      unsatisfied.add(describeRequirement(req));
    }
  }
  if (unsatisfied.size > 0) {
    return {
      name,
      status: 'warn',
      message: `No connected agent or scaler can satisfy: ${[...unsatisfied].join('; ')}.`,
      details: { unsatisfied: [...unsatisfied] },
      nextCommand: 'kici diagnostics',
    };
  }
  return {
    name,
    status: 'pass',
    message: 'All workflow labels are satisfiable by connected capacity.',
  };
}

export interface DoctorOptions {
  json?: boolean;
  kiciDir?: string;
}

/** Injectable seams for unit tests. */
export interface DoctorDeps {
  loadConfig: () => Promise<GlobalConfig>;
  probe: (config: GlobalConfig) => Promise<ProbeOutcome | null>;
  gatherLockState: (kiciDir: string) => Promise<LockState>;
  now: () => number;
  /** Defaults to `GET /api/v1/test/whoami`. */
  probeDirect?: (url: string, token: string) => Promise<DirectProbe>;
  /** Run-target resolution env; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Whether `.kici/` has workflows but no package.json; defaults to reading the disk. */
  inspectAgentDeps?: (kiciDir: string) => Promise<boolean>;
}

async function defaultProbeDirect(url: string, token: string): Promise<DirectProbe> {
  try {
    return { ok: true, whoami: await new DirectRunClient({ url, token }).whoami() };
  } catch (err) {
    const message = toErrorMessage(err);
    if (err instanceof AuthenticationError) return { ok: false, kind: 'auth', message };
    if (err instanceof ConnectionError) return { ok: false, kind: 'unreachable', message };
    if (err instanceof DirectApiUnavailableError) {
      return { ok: false, kind: 'unavailable', message };
    }
    return { ok: false, kind: 'error', message };
  }
}

/** Newest *.ts mtime (ms) directly in the workflows directory, or 0. */
async function newestWorkflowMtime(workflowsDir: string): Promise<number> {
  let newest = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(workflowsDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    try {
      const st = await fs.stat(path.join(workflowsDir, entry));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* ignore unreadable entries */
    }
  }
  return newest;
}

async function gitCleanForPath(
  filePath: string,
): Promise<{ gitAvailable: boolean; committed: boolean }> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', filePath], {
      cwd: path.dirname(filePath),
    });
    return { gitAvailable: true, committed: stdout.trim() === '' };
  } catch {
    return { gitAvailable: false, committed: false };
  }
}

async function defaultGatherLockState(kiciDir: string): Promise<LockState> {
  const abs = resolveKiciDir(kiciDir);
  const lockPath = path.join(abs, 'kici.lock.json');
  let lock: LockFile | null = null;
  let lockMtime = 0;
  try {
    const st = await fs.stat(lockPath);
    lockMtime = st.mtimeMs;
    lock = JSON.parse(await fs.readFile(lockPath, 'utf-8')) as LockFile;
  } catch {
    return { exists: false, fresh: false, committed: false, gitAvailable: false, lock: null };
  }
  const newestSrc = await newestWorkflowMtime(path.join(abs, 'workflows'));
  const { gitAvailable, committed } = await gitCleanForPath(lockPath);
  return { exists: true, fresh: lockMtime >= newestSrc, committed, gitAvailable, lock };
}

async function probeInfrastructure(client: DashboardClient): Promise<ProbeOutcome> {
  try {
    return { ok: true, infra: await client.getInfrastructure() };
  } catch (err) {
    if (err instanceof DashboardClientError) {
      return { ok: false, kind: err.kind, message: err.message };
    }
    return { ok: false, kind: 'http', message: toErrorMessage(err) };
  }
}

/** Null without credentials or an active org. */
async function defaultProbe(config: GlobalConfig): Promise<ProbeOutcome | null> {
  if (!hasCredentials(config) || !config.activeOrgId) return null;
  let client: DashboardClient;
  try {
    client = DashboardClient.fromConfig(config);
  } catch (err) {
    if (err instanceof DashboardClientError) {
      return { ok: false, kind: err.kind, message: err.message };
    }
    throw err;
  }
  return probeInfrastructure(client);
}

const defaultDeps: DoctorDeps = {
  loadConfig: loadGlobalConfig,
  probe: defaultProbe,
  gatherLockState: defaultGatherLockState,
  now: Date.now,
};

function colorizeStatus(status: string): string {
  switch (status) {
    case 'pass':
    case 'healthy':
      return pc.green(status);
    case 'warn':
    case 'degraded':
      return pc.yellow(status);
    case 'fail':
    case 'unhealthy':
      return pc.red(status);
    default:
      return status;
  }
}

export function renderDoctorTable(
  response: DiagnoseResponse & { checks: DoctorCheckResult[] },
): string {
  const lines: string[] = [];
  lines.push(`${pc.bold('kici doctor')}  ${colorizeStatus(response.status)}`);
  lines.push('');
  for (const c of response.checks) {
    lines.push(`${colorizeStatus(c.status.padEnd(4))}  ${pc.bold(c.name.padEnd(14))} ${c.message}`);
    if (c.nextCommand) lines.push(`      ${pc.cyan(`→ ${c.nextCommand}`)}`);
  }
  return lines.join('\n');
}

/**
 * Returns the exit code (0 all pass · 1 any warn · 2 any fail). The
 * infrastructure probe's time is attributed to token-live; local checks are instant.
 */
export async function doctorCommand(
  options: DoctorOptions = {},
  deps: DoctorDeps = defaultDeps,
): Promise<number> {
  const config = await deps.loadConfig();
  const now = deps.now();
  const lockState = await deps.gatherLockState(options.kiciDir ?? '.kici');

  const resolution = resolveRunTarget({ env: deps.env ?? process.env, config });
  const direct = resolution.ok && resolution.target.kind === 'direct' ? resolution.target : null;
  const directStart = deps.now();
  const directProbe = direct
    ? await (deps.probeDirect ?? defaultProbeDirect)(direct.url, direct.token)
    : null;
  const directMs = Math.max(0, deps.now() - directStart);
  const runTarget = { ...checkRunTarget(resolution, directProbe), durationMs: directMs };

  // A direct-orchestrator-only developer has no Platform login; `kici login`
  // advice would send them the wrong way.
  const platformRows = hasCredentials(config) || !direct;
  const lockFile = { ...checkLockFile(lockState), durationMs: 0 };
  const deprecated = checkDeprecatedConfig(config);
  const inspect =
    deps.inspectAgentDeps ?? ((dir: string) => kiciDirNeedsManifest(resolveKiciDir(dir)));
  const agentDeps = checkAgentDeps(await inspect(options.kiciDir ?? '.kici'));

  let checks: DoctorCheckResult[];
  if (platformRows) {
    const probeStart = deps.now();
    const probe = await deps.probe(config);
    const probeMs = Math.max(0, deps.now() - probeStart);
    checks = [
      runTarget,
      { ...checkLogin(config, now), durationMs: 0 },
      { ...checkActiveOrg(config), durationMs: 0 },
      lockFile,
      { ...checkLiveToken(probe), durationMs: probeMs },
      { ...checkOrchestrator(probe), durationMs: 0 },
      { ...checkLabels(lockState.lock, probe), durationMs: 0 },
    ];
  } else {
    checks = [runTarget, lockFile];
  }
  if (agentDeps) checks.push({ ...agentDeps, durationMs: 0 });
  if (deprecated) checks.push({ ...deprecated, durationMs: 0 });

  const response: DiagnoseResponse & { checks: DoctorCheckResult[] } = {
    status: deriveDiagnoseOverall(checks),
    checks,
    timestamp: new Date(now).toISOString(),
  };

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    console.log(renderDoctorTable(response));
  }
  return diagnoseExitCode(checks);
}
