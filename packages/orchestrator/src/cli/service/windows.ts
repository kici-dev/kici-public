/**
 * Windows service manager: shawl (https://github.com/mtkennerly/shawl), a lazy
 * dependency downloaded on first use, wraps the executable as a service, and
 * sc.exe configures auto-start and recovery.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_ENV_FILE_VAR } from '@kici-dev/shared/service-env-file';
import type {
  ServiceManager,
  ServiceConfig,
  ServiceStatus,
  LogOptions,
  ServiceState,
  DiscoveredInstance,
  LaunchSpec,
} from './types.js';
import { ensureDep } from '../lazy-deps/downloader.js';
import { getDepMetadata } from '../lazy-deps/registry.js';
import { getCacheDir } from './platform-detect.js';
import { shutdownGraceSeconds, stopWaitSeconds } from './shutdown-grace.js';
import { restrictEnvFileAccess } from './windows-acl.js';
import { envFileRefusal, launchReadsEnvFile, launchedRelease } from './windows-env-file.js';
import {
  BATCH_STDIN,
  BATCH_WRAPPER_ARGS,
  assertCmdSafe,
  batchFileCommand,
  isBatchFile,
} from '../../helpers/windows-batch.js';
import { sleep } from '@kici-dev/engine';

/**
 * How long a discovery-path probe of the service registry may run. Matches the
 * compose driver's `RUNTIME_PROBE_TIMEOUT_MS` and `killSignal`: a discovery read
 * must fail in seconds, not hang a `kici-admin` command, and a client blocked on
 * an unresponsive service ignores SIGTERM.
 *
 * Only `available()` and `list()` take it. The lifecycle `sc.exe` calls act on
 * ONE service the operator named, so a slow answer there is the operator's own
 * install/uninstall, not a scan silently reporting a shorter host. Unlike
 * compose's, the healthy cost is not quoted: it is dominated by PowerShell
 * startup and cannot be measured from this repo's Linux hosts.
 */
const SERVICE_REGISTRY_PROBE_TIMEOUT_MS = 10_000;

/**
 * sc.exe STATE codes: 1 STOPPED, 2 START_PENDING, 3 STOP_PENDING, 4 RUNNING,
 * 5 CONTINUE_PENDING, 6 PAUSE_PENDING, 7 PAUSED.
 */
function parseWindowsState(stateCode: number): ServiceState {
  switch (stateCode) {
    case 4:
      return 'running';
    case 1:
      return 'stopped';
    case 2:
    case 3:
    case 5:
    case 6:
    case 7:
      return 'stopped';
    default:
      return 'unknown';
  }
}

/** The PID from sc.exe query output (`PID : 1234`); 0 means no process. */
function parsePid(output: string): number | undefined {
  const match = output.match(/PID\s*:\s*(\d+)/);
  if (match && match[1] !== '0') {
    return parseInt(match[1], 10);
  }
  return undefined;
}

/** The STATE code from sc.exe query output (`STATE : 4  RUNNING`). */
function parseStateCode(output: string): number | undefined {
  const match = output.match(/STATE\s*:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/** ERROR_SERVICE_NOT_ACTIVE: `sc.exe stop` on a service that is not running (sc.exe exits with the Win32 error code). */
const ERROR_SERVICE_NOT_ACTIVE = 1062;

/** ERROR_SERVICE_CANNOT_ACCEPT_CTRL: `sc.exe stop` on a service that is starting or stopping. */
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL = 1061;

/** What a service command runs as, and what to change, in a cmd.exe refusal. */
const SERVICE_USE = 'as a Windows service';
const SERVICE_REMEDY = 'Install from a path without it.';

/** The command shawl registers; a batch file runs through cmd.exe ({@link BATCH_WRAPPER_ARGS}). */
function serviceCommand(config: ServiceConfig): string[] {
  const command = [config.executablePath, ...(config.args ?? [])];
  if (!isBatchFile(config.executablePath)) return command;
  command.forEach((token) => assertCmdSafe(token, SERVICE_USE, SERVICE_REMEDY));
  return batchFileCommand(command);
}

/** The launch command inside a {@link serviceCommand}: a batch file's cmd.exe wrapper removed. */
function unwrapServiceCommand(tokens: string[]): string[] {
  const [exe, ...rest] = tokens;
  const wrapped =
    exe !== undefined &&
    /(^|\\)cmd\.exe$/i.test(exe) &&
    BATCH_WRAPPER_ARGS.every((arg, i) => rest[i]?.toLowerCase() === arg) &&
    rest.at(-1) === BATCH_STDIN &&
    rest.length > BATCH_WRAPPER_ARGS.length + 1;
  return wrapped ? rest.slice(BATCH_WRAPPER_ARGS.length, -1) : tokens;
}

export class WindowsServiceManager implements ServiceManager {
  readonly platform = 'windows' as const;

  /**
   * True when the service registry `list()` reads (CIM `Win32_Service`)
   * answers: a filter that cannot match returns an empty set and exit 0.
   * It does NOT probe for `powershell` or `sc.exe`: a client-only probe let the
   * compose sibling answer while its registry was down, and the empty scan
   * then pruned live rows. A name filter assumes no service exists and parses
   * no display string, so the probe has no locale or edition assumption.
   */
  async available(): Promise<boolean> {
    try {
      execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Service -Filter \\"Name=\'kici-availability-probe-no-such-service\'\\" | Out-Null"',
        {
          stdio: 'pipe',
          timeout: SERVICE_REGISTRY_PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** `sc.exe query` exits 0 when the service exists, possibly pending-delete. */
  private serviceExists(name: string): boolean {
    try {
      execSync(`sc.exe query ${name}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /** The service's STATE code from `sc.exe query`, or undefined when the query fails. */
  private queryStateCode(name: string): number | undefined {
    try {
      return parseStateCode(execSync(`sc.exe query ${name}`, { stdio: 'pipe' }).toString());
    } catch {
      return undefined;
    }
  }

  async install(config: ServiceConfig): Promise<void> {
    // Before anything is removed: a launch command shawl cannot run is refused
    // while the installed service is still in place.
    const command = serviceCommand(config);
    // A release from before KICI_ENV_FILE could run only with the env file's
    // values on its command line, which any local account reads.
    if (!launchReadsEnvFile(config)) {
      throw new Error(
        `cannot register ${config.name}: ` +
          envFileRefusal(launchedRelease(config), config.envFilePath),
      );
    }

    const envDir = path.dirname(config.envFilePath);
    fs.mkdirSync(envDir, { recursive: true });

    // Only LocalSystem and Administrators may read the env file's folder; the
    // log folder below inherits the ACL. It also covers a folder an older CLI
    // installed, since every archive upgrade re-registers through here. It runs
    // before the uninstall, so a failure leaves the service registered. A
    // user-level folder sits in its user's profile, which no other account reads.
    if (!config.isUserLevel) restrictEnvFileAccess(config.envFilePath);

    // A registered or pending-delete service is removed first through
    // uninstall()'s stop → delete → poll-until-gone, so `shawl add` never hits
    // `sc create` 1073 (ERROR_SERVICE_EXISTS). The existence guard is required:
    // `sc.exe delete` throws on a missing service. Do NOT wrap uninstall() in
    // try/catch — its hung-process error must propagate, not become a later 1073.
    if (this.serviceExists(config.name)) {
      await this.uninstall(config);
    }

    const depMeta = getDepMetadata('shawl');
    const cacheDir = getCacheDir();
    const depPath = await ensureDep(depMeta, cacheDir);
    const shawlExe = path.join(depPath, depMeta.extractPath);

    // A trailing backslash would escape the closing quote ("C:\dir\" parses as
    // "C:\dir" plus an escaped quote).
    const cwd = config.workingDirectory.replace(/\\+$/, '');
    const logDir = path.join(envDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const cmdParts = [
      `"${shawlExe}"`,
      'add',
      '--name',
      `"${config.name}"`,
      '--cwd',
      `"${cwd}"`,
      '--log-dir',
      `"${logDir.replace(/\\+$/, '')}"`,
      // Wait after ctrl-C before the kill; shawl's default is shorter than the
      // service's graceful-shutdown budget.
      '--stop-timeout',
      String(shutdownGraceSeconds(config) * 1000),
    ];

    // The env file's path, never its values: any local account reads the
    // command line with `sc.exe qc`. The process loads the file at start
    // (`@kici-dev/shared/load-service-env-file`), so an edit applies next start.
    cmdParts.push('--env', `"${SERVICE_ENV_FILE_VAR}=${config.envFilePath}"`);
    cmdParts.push('--', ...command.map((token) => `"${token}"`));
    const cmd = cmdParts.join(' ');

    execSync(cmd, { stdio: 'pipe' });

    // Windows has no unit metadata, so the description carries list()'s
    // markers: a `[KiCI:<component>]` prefix, and a `[KiCI-DIR:<path>]` suffix
    // that makes the instance index a rebuildable cache.
    const dirSuffix =
      config.component && config.instanceDir ? ` [KiCI-DIR:${config.instanceDir}]` : '';
    const descText = config.component
      ? `[KiCI:${config.component}] ${config.description}${dirSuffix}`
      : config.description;
    execSync(`sc.exe description ${config.name} "${descText.replace(/"/g, '\\"')}"`, {
      stdio: 'pipe',
    });

    execSync(`sc.exe config ${config.name} start= auto`, { stdio: 'pipe' });

    const delays = config.restartPolicy.delays;
    const actions = delays.map((d) => `restart/${d * 1000}`).join('/');
    const resetSeconds = config.restartPolicy.windowSeconds;
    execSync(`sc.exe failure ${config.name} reset= ${resetSeconds} actions= ${actions}`, {
      stdio: 'pipe',
    });
  }

  async uninstall(config: ServiceConfig): Promise<void> {
    const waitSeconds = stopWaitSeconds(config);

    // Let the process exit before the delete: shawl gives it the whole
    // shutdown grace.
    try {
      execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });
    } catch {
      // Already stopped.
    }
    const stopDeadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < stopDeadline) {
      const stateCode = this.queryStateCode(config.name);
      if (stateCode === 1 || stateCode === undefined) break; // STOPPED, or gone
      await sleep(500);
    }

    // sc.exe delete defers the deletion until the process exits; poll until it
    // is gone, or a re-install hits "service already exists".
    execSync(`sc.exe delete ${config.name}`, { stdio: 'pipe' });

    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      if (!this.serviceExists(config.name)) return; // deletion complete
      await sleep(1_000);
    }

    throw new Error(
      `Service ${config.name} still exists ${waitSeconds}s after sc.exe delete. ` +
        `The process may be hung — check Task Manager and kill manually if needed.`,
    );
  }

  async start(config: ServiceConfig): Promise<void> {
    // `sc.exe start` fails with 1056 in STOP_PENDING (3, until the process
    // exits) and in RUNNING (4), so wait for STOPPED and treat RUNNING as a no-op.
    const deadline = Date.now() + stopWaitSeconds(config) * 1000;
    while (Date.now() < deadline) {
      // A query can fail transiently during state transitions; retry.
      const stateCode = this.queryStateCode(config.name);
      if (stateCode === 4) return; // RUNNING
      if (stateCode === 1) break; // STOPPED
      await sleep(500);
    }

    execSync(`sc.exe start ${config.name}`, { stdio: 'pipe' });
  }

  async stop(config: ServiceConfig): Promise<void> {
    try {
      execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });
    } catch (err) {
      // 1062 (not running) and 1061 (already stopping) succeed once the query
      // confirms STOPPED; a stop in progress is left to the wait below. Any
      // other failure (access denied, no such service, starting) surfaces.
      const status = (err as { status?: unknown })?.status;
      if (status !== ERROR_SERVICE_NOT_ACTIVE && status !== ERROR_SERVICE_CANNOT_ACCEPT_CTRL) {
        throw err;
      }
      const stateCode = this.queryStateCode(config.name);
      if (stateCode === 1) return;
      if (status !== ERROR_SERVICE_CANNOT_ACCEPT_CTRL || stateCode !== 3) throw err;
    }

    // `sc.exe stop` returns at once in STOP_PENDING (3); STOPPED (1) follows
    // the process exit, up to the whole shutdown grace. Return only at
    // STOPPED, or an immediate `start` hits error 1056.
    const waitSeconds = stopWaitSeconds(config);
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      if (this.queryStateCode(config.name) === 1) return; // STOPPED
      await sleep(500);
    }

    throw new Error(
      `Service ${config.name} did not reach STOPPED state within ${waitSeconds}s after sc.exe stop. ` +
        `A subsequent start would fail with error 1056 — the service may be hung.`,
    );
  }

  async restart(config: ServiceConfig): Promise<void> {
    await this.stop(config);
    await this.start(config);
  }

  async status(config: ServiceConfig): Promise<ServiceStatus> {
    try {
      const output = execSync(`sc.exe query ${config.name}`, { stdio: 'pipe' }).toString();
      const stateCode = parseStateCode(output);
      const state = stateCode !== undefined ? parseWindowsState(stateCode) : 'unknown';
      const pid = parsePid(output);

      return { state, pid };
    } catch {
      return { state: 'unknown' };
    }
  }

  async logs(config: ServiceConfig, _options: LogOptions): Promise<void> {
    const count = 100;
    const query = `*[System[Provider[@Name='${config.name}']]]`;
    const cmd = `wevtutil qe Application /q:"${query}" /f:text /rd:true /c:${count}`;

    try {
      const output = execSync(cmd, { stdio: 'pipe' }).toString();
      console.log(output);
    } catch (err) {
      console.error(`Failed to read Windows Event Log: ${err}`);
    }
  }

  async isInstalled(config: ServiceConfig): Promise<boolean> {
    try {
      execSync(`sc.exe query ${config.name}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async list(isUserLevel: boolean): Promise<DiscoveredInstance[]> {
    // The `[KiCI:<component>]` description prefix marks a KiCI service.
    // `isUserLevel` is advisory: the SCM is system-wide, but each instance
    // records the scope the caller asked about.
    // A failed registry read is NOT an empty registry: `listInstances` prunes
    // this platform's index rows on an empty scan, so `[]` here would delete
    // every windows row the first time WMI hiccups. Both failures throw, and
    // `scanDrivers` drops this driver as if `available()` said false.
    let raw: string;
    try {
      // Coerced to string so a `Buffer.from(...)` mock and real stdout share
      // one JSON.parse path.
      raw = execSync(
        'powershell -Command "Get-CimInstance Win32_Service -Filter \\"Name LIKE \'kici-%\'\\" | Select-Object Name,Description | ConvertTo-Json"',
        {
          stdio: 'pipe',
          timeout: SERVICE_REGISTRY_PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      ).toString();
    } catch (err) {
      throw new Error(
        `could not read the Windows service registry: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // The one honest `[]`: `ConvertTo-Json` emits nothing when no service matches.
    if (!raw.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `the Windows service registry returned unparseable output: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // `ConvertTo-Json` emits a bare object for a single row.
    const rows = Array.isArray(parsed) ? parsed : [parsed];

    const out: DiscoveredInstance[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { Name?: unknown; Description?: unknown };
      const desc = typeof r.Description === 'string' ? r.Description : '';
      const match = desc.match(/^\[KiCI:(orchestrator|agent)\]/);
      if (!match) continue;
      if (typeof r.Name !== 'string') continue;
      const dirMatch = desc.match(/\[KiCI-DIR:([^\]]+)\]/);
      out.push({
        name: r.Name,
        platform: 'windows',
        isUserLevel,
        component: match[1] as 'orchestrator' | 'agent',
        instanceDir: dirMatch?.[1],
      });
    }
    return out;
  }

  /**
   * The registered command line. `sc.exe qc` fails (error 1734) past about
   * 4000 characters, as an older CLI's registration with every env-file value
   * can be, and prints in the console code page, so a non-ASCII path (a user
   * named Jürgen) decodes to U+FFFD. Either case reads the `ImagePath`
   * registry value through PowerShell as UTF-8.
   */
  private registeredCommandLine(name: string): string | null {
    try {
      const raw = execSync(`sc.exe qc ${name}`, { stdio: 'pipe' }).toString();
      const line = raw.match(/BINARY_PATH_NAME\s*:\s*(.+)/)?.[1]?.trim();
      if (line && !line.includes('\uFFFD')) return line;
    } catch {
      // Too long for sc.exe, or not installed: the registry read answers both.
    }
    const key = `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${name.replace(/'/g, "''")}`;
    try {
      const raw = execSync(
        'powershell -NoProfile -NonInteractive -Command "' +
          '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
          `(Get-ItemProperty -LiteralPath '${key}').ImagePath"`,
        { stdio: 'pipe' },
      ).toString('utf-8');
      return raw.replace(/^\uFEFF/, '').trim() || null;
    } catch {
      return null;
    }
  }

  async readLaunchSpec(config: ServiceConfig): Promise<LaunchSpec | null> {
    const line = this.registeredCommandLine(config.name);
    if (line === null) return null;
    // shawl registers `"shawl.exe" run --name <name> ... -- "<exec>" "<arg>" ...`
    // and splits at the first unquoted `--`; a quoted --cwd or --env value may
    // hold " -- ".
    const parts = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((t) => ({
      text: t[1] ?? t[2]!,
      quoted: t[1] !== undefined,
    }));
    const sep = parts.findIndex((p) => !p.quoted && p.text === '--');
    if (sep === -1) return null;
    const tokens = unwrapServiceCommand(parts.slice(sep + 1).map((p) => p.text));
    if (tokens.length === 0 || !tokens[0]) return null;
    return { execPath: tokens[0], args: tokens.slice(1) };
  }
}
