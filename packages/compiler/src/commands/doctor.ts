/**
 * kici doctor — walk the onboarding funnel and diagnose where a developer's
 * setup breaks. Each check reports pass/warn/fail with the exact next command
 * to run. Composed entirely from client-side state (the stored config, one
 * authenticated infrastructure read, and local filesystem/git state) — no new
 * Platform API is required.
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
  matcherSatisfiedBy,
  type DiagnosticsInfrastructureResponse,
  type LabelMatcher,
} from '@kici-dev/engine';
import { loadGlobalConfig, type GlobalConfig } from '../remote/config.js';
import { resolveKiciDir } from '../execution/index.js';
import {
  DashboardClient,
  DashboardClientError,
  type DashboardErrorKind,
} from '../remote/dashboard-client.js';
import { isLockStaticJob, type LockFile } from '../types.js';

const execFileAsync = promisify(execFile);

/** A doctor check result: a shared DiagnoseResult plus the exact fix command. */
export interface DoctorCheckResult extends DiagnoseResult {
  nextCommand?: string;
}

/** A check body before the runner stamps its measured duration. */
export type DoctorCheckBody = Omit<DoctorCheckResult, 'durationMs'>;

/** The outcome of the single authenticated infrastructure probe. */
export type ProbeOutcome =
  | { ok: true; infra: DiagnosticsInfrastructureResponse }
  | { ok: false; kind: DashboardErrorKind; message: string };

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Is a stored token + endpoint present (regardless of expiry)? */
export function hasCredentials(config: GlobalConfig): boolean {
  return Boolean((config.pat ?? config.token) && (config.platformEndpoint ?? config.endpoint));
}

/** Check 1: logged in with an unexpired token. */
export function checkLogin(config: GlobalConfig, now: number): DoctorCheckBody {
  const name = 'login';
  const endpoint = config.platformEndpoint ?? config.endpoint;
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

/** Check 2: an active organization is selected. */
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

/** Check 3: the Platform accepted the stored token (live-token probe). */
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

/** Local + git state of the compiled lock file. */
export interface LockState {
  exists: boolean;
  fresh: boolean; // lock mtime >= newest workflow-source mtime
  committed: boolean; // git working tree clean for the lock path
  gitAvailable: boolean; // false when the workspace is not a git repo
  lock: LockFile | null; // parsed contents when present
}

/** Check 4: an orchestrator is connected for this org. */
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

/** Check 5: the lock file is present, fresh, and committed. */
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

/** A job's targeting constraint: the runsOn set it needs, minus the labels it excludes. */
interface LabelRequirement {
  runsOn: readonly LabelMatcher[];
  exclude: readonly LabelMatcher[];
}

/**
 * A label group satisfies a requirement only when it matches EVERY runsOn
 * matcher AND matches NONE of the excludeLabels — the same authority the
 * orchestrator's job queue applies (`runsOn.every` && `!exclude.some`).
 */
function requirementSatisfiedBy(req: LabelRequirement, labels: ReadonlySet<string>): boolean {
  return (
    req.runsOn.every((m) => matcherSatisfiedBy(m, labels)) &&
    !req.exclude.some((m) => matcherSatisfiedBy(m, labels))
  );
}

function describeMatcher(m: LabelMatcher): string {
  return m.kind === 'regex' ? `/${m.source}/${m.flags}` : m.value;
}

function describeRequirement(req: LabelRequirement): string {
  const base = req.runsOn.map(describeMatcher).join(' + ');
  return req.exclude.length > 0 ? `${base} − ${req.exclude.map(describeMatcher).join(', ')}` : base;
}

/**
 * Collect the label groups that can satisfy a runsOn set on their own: each
 * connected agent's label set, and each scaler labelSet.
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

/** Check 6: every workflow's runsOn labels are satisfiable by a connected agent or scaler. */
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
      if (runsOn.length === 0) continue; // no constraint — any agent works
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

/** Injectable seams so every path is unit-testable without real IO. */
export interface DoctorDeps {
  loadConfig: () => Promise<GlobalConfig>;
  probe: (config: GlobalConfig) => Promise<ProbeOutcome | null>;
  gatherLockState: (kiciDir: string) => Promise<LockState>;
  now: () => number;
}

/** Newest mtime (ms) across every *.ts under the workflows directory, or 0. */
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

/** Is the working tree clean for the given path? gitAvailable=false when not a repo. */
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

/** Default gatherer: read the lock file, compute freshness by mtime, check git. */
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

/** Default probe: attempt one authenticated infrastructure read, or null when not eligible. */
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

/** Render the funnel as a status table with a trailing next-command hint per row. */
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
 * Run the onboarding-funnel diagnostic and return the process exit code
 * (0 all pass · 1 any warn · 2 any fail). The single infrastructure probe is
 * timed and attributed to the token-live check; the local checks are instant.
 */
export async function doctorCommand(
  options: DoctorOptions = {},
  deps: DoctorDeps = defaultDeps,
): Promise<number> {
  const config = await deps.loadConfig();
  const now = deps.now();
  const lockState = await deps.gatherLockState(options.kiciDir ?? '.kici');

  const probeStart = deps.now();
  const probe = await deps.probe(config);
  const probeMs = Math.max(0, deps.now() - probeStart);

  const checks: DoctorCheckResult[] = [
    { ...checkLogin(config, now), durationMs: 0 },
    { ...checkActiveOrg(config), durationMs: 0 },
    { ...checkLockFile(lockState), durationMs: 0 },
    { ...checkLiveToken(probe), durationMs: probeMs },
    { ...checkOrchestrator(probe), durationMs: 0 },
    { ...checkLabels(lockState.lock, probe), durationMs: 0 },
  ];

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
