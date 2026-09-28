/**
 * Windows service manager using shawl + sc.exe.
 *
 * Uses shawl (https://github.com/mtkennerly/shawl) to wrap the KiCI
 * executable as a Windows service. Shawl is downloaded as a lazy
 * dependency on first use. Service configuration (auto-start, recovery)
 * is handled via sc.exe.
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

/**
 * How long a discovery-path probe of the service registry may run.
 *
 * Matches the compose driver's `RUNTIME_PROBE_TIMEOUT_MS`, for the same reason
 * and with the same `killSignal`: a registry read on the discovery path must
 * fail in seconds rather than hang a `kici-admin` command indefinitely, and a
 * client blocked on an unresponsive service ignores a polite SIGTERM.
 *
 * Only the two discovery calls take it — `available()` and `list()`. The
 * lifecycle `sc.exe` calls are a deliberate exception: they act on ONE named
 * service the operator asked for, so a slow answer there is the operator's own
 * install/uninstall taking its time, not a scan silently reporting a shorter
 * host.
 *
 * The healthy cost is not quoted here, unlike compose's, because it cannot be
 * measured from this repo's Linux hosts — it is dominated by PowerShell
 * startup and is the same shape as `list()`'s own call.
 */
const SERVICE_REGISTRY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Map Windows service state codes to our ServiceState type.
 *
 * Windows sc.exe query output includes STATE codes:
 * - 1: STOPPED
 * - 2: START_PENDING
 * - 3: STOP_PENDING
 * - 4: RUNNING
 * - 5: CONTINUE_PENDING
 * - 6: PAUSE_PENDING
 * - 7: PAUSED
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

/**
 * Parse the PID from sc.exe query output.
 * Looks for the PID line: "        PID                : 1234"
 */
function parsePid(output: string): number | undefined {
  const match = output.match(/PID\s*:\s*(\d+)/);
  if (match && match[1] !== '0') {
    return parseInt(match[1], 10);
  }
  return undefined;
}

/**
 * Parse the STATE code from sc.exe query output.
 * Looks for: "        STATE              : 4  RUNNING"
 */
function parseStateCode(output: string): number | undefined {
  const match = output.match(/STATE\s*:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/** ERROR_SERVICE_NOT_ACTIVE: `sc.exe stop` on a service that is not running (sc.exe exits with the Win32 error code). */
const ERROR_SERVICE_NOT_ACTIVE = 1062;

/** ERROR_SERVICE_CANNOT_ACCEPT_CTRL: `sc.exe stop` on a service that is starting or stopping. */
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL = 1061;

/** Async sleep used to pace the `sc.exe query` polls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The cmd.exe arguments that run a batch-file launcher, ahead of its path.
 *
 * shawl stops the service with a ctrl-C to its console, and cmd.exe gets it
 * too: when the batch file's node process exits, cmd.exe asks "Terminate batch
 * job (Y/N)?" and waits for an answer. shawl sees the service exit only when its
 * stop timeout kills cmd.exe. With stdin from NUL ({@link BATCH_STDIN}), cmd.exe
 * reads end-of-input at that prompt and exits with node.
 *
 * `call` keeps the launcher path out of the first position after `/c`, where
 * cmd.exe strips the quotes from a path that contains `(`, `)` or `&`. `/e:on`
 * and `/v:off` pin command extensions (the launchers use `%~dp0`) and delayed
 * expansion whatever the host's registry defaults are.
 */
const BATCH_WRAPPER_ARGS = ['/d', '/e:on', '/v:off', '/c', 'call'] as const;

/** The redirect that closes {@link BATCH_WRAPPER_ARGS}: the launcher's stdin is NUL. */
const BATCH_STDIN = '<NUL';

/** A `.cmd` or `.bat` file, which Windows runs through cmd.exe. */
function isBatchFile(executablePath: string): boolean {
  return /\.(cmd|bat)$/i.test(executablePath);
}

/**
 * The cmd.exe that COMSPEC names, as Node itself uses to run a shell on Windows.
 * A COMSPEC that names another shell is not used: the wrapper arguments are
 * cmd.exe's.
 */
function cmdExePath(): string {
  const comspec = process.env.COMSPEC;
  return comspec && /(^|\\)cmd\.exe$/i.test(comspec) ? comspec : 'C:\\Windows\\System32\\cmd.exe';
}

/**
 * Throw when cmd.exe would read part of `token` as syntax.
 *
 * shawl quotes a token on cmd.exe's command line only when it contains a space
 * or a tab. Inside quotes cmd.exe reads `&`, `|`, `<`, `>`, `(`, `)` and the
 * `,` `;` `=` delimiters as text; outside quotes it reads them as syntax. `%`
 * and `^` change even inside quotes (`call` expands `%` again and doubles `^`),
 * and a `"` ends the quoting.
 */
function assertCmdSafe(token: string): void {
  const syntax = /[ \t]/.test(token) ? /["%^]/ : /["%^&|<>(),;=]/;
  const found = syntax.exec(token);
  if (found) {
    throw new Error(
      `cannot run "${token}" as a Windows service: it contains "${found[0]}", which cmd.exe ` +
        `reads as syntax when it runs the batch file. Install from a path without it.`,
    );
  }
}

/**
 * The command shawl registers for the service: the executable and its
 * arguments, with a batch file run through cmd.exe ({@link BATCH_WRAPPER_ARGS}).
 */
function serviceCommand(config: ServiceConfig): string[] {
  const command = [config.executablePath, ...(config.args ?? [])];
  if (!isBatchFile(config.executablePath)) return command;
  command.forEach(assertCmdSafe);
  return [cmdExePath(), ...BATCH_WRAPPER_ARGS, ...command, BATCH_STDIN];
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
   * True when the service registry this driver reads actually answers.
   *
   * Probes the same subsystem `list()` reads — CIM's `Win32_Service` — with a
   * filter that cannot match, so a healthy host answers with an empty result
   * set and exits 0. It deliberately does NOT probe for the presence of
   * `powershell` or `sc.exe`: a client-only probe is exactly the defect this
   * driver's compose sibling had, where the client answered on a host whose
   * registry was down and the empty scan then pruned live rows.
   *
   * A name filter rather than a well-known service name: no service is assumed
   * to exist, and no display string is parsed, so the probe carries no locale
   * or Windows-edition assumption.
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

  /**
   * Check whether a Windows service is currently registered.
   * `sc.exe query` exits non-zero (execSync throws) when the service does
   * not exist; exit 0 means it exists (possibly pending-delete).
   */
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

    // Ensure env file directory exists
    const envDir = path.dirname(config.envFilePath);
    fs.mkdirSync(envDir, { recursive: true });

    // Only LocalSystem and Administrators may read the folder that holds the
    // env file; the log folder created below inherits the same ACL. This also
    // restricts the folder of an instance an older CLI installed, which every
    // archive upgrade registers again through this method. It runs while the
    // installed service is still in place, so a failure leaves it registered.
    // A user-level folder sits in the profile of its user, which no other
    // account can read.
    if (!config.isUserLevel) restrictEnvFileAccess(config.envFilePath);

    // Idempotency: if the service is already registered (or pending-delete
    // from a prior deploy whose stop/delete didn't cleanly finish), remove it
    // first — reusing uninstall()'s stop → delete → poll-until-gone — so
    // `shawl add` never hits `sc create` 1073 (ERROR_SERVICE_EXISTS). The
    // existence guard is required: uninstall() runs `sc.exe delete`, which
    // throws on a non-existent service, so a fresh box must skip it. Do NOT
    // wrap uninstall() in try/catch — its clear hung-process error must
    // propagate instead of surfacing later as a cryptic 1073.
    if (this.serviceExists(config.name)) {
      await this.uninstall(config);
    }

    // Download shawl via lazy deps
    const depMeta = getDepMetadata('shawl');
    const cacheDir = getCacheDir();
    const depPath = await ensureDep(depMeta, cacheDir);
    const shawlExe = path.join(depPath, depMeta.extractPath);

    // Register the service via shawl.
    // Strip trailing backslash from paths to avoid escaping the closing quote
    // on Windows (e.g., "C:\dir\" is parsed as "C:\dir" with escaped quote).
    const cwd = config.workingDirectory.replace(/\\+$/, '');
    // Create log directory for shawl to capture stdout/stderr
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
      // How long shawl waits after the ctrl-C before it kills the process. Its
      // default is shorter than the service's own graceful-shutdown budget.
      '--stop-timeout',
      String(shutdownGraceSeconds(config) * 1000),
    ];

    // The registration carries the env file's path, never its values: any
    // local account reads a service's command line with `sc.exe qc`. The
    // orchestrator and the agent load the file themselves when they start
    // (`@kici-dev/shared/load-service-env-file`), so an edit to it takes
    // effect at the next start.
    cmdParts.push('--env', `"${SERVICE_ENV_FILE_VAR}=${config.envFilePath}"`);
    cmdParts.push('--', ...command.map((token) => `"${token}"`));
    const cmd = cmdParts.join(' ');

    execSync(cmd, { stdio: 'pipe' });

    // Set the service description. When `config.component` is set, prefix the
    // description with `[KiCI:<component>]` — marker decoded by list().
    // Windows lacks first-class unit metadata; description is the anchor.
    // When `config.instanceDir` is set, append a `[KiCI-DIR:<path>]` suffix so
    // list() can recover the deploy folder straight from the description,
    // making the instance index a rebuildable cache.
    const dirSuffix =
      config.component && config.instanceDir ? ` [KiCI-DIR:${config.instanceDir}]` : '';
    const descText = config.component
      ? `[KiCI:${config.component}] ${config.description}${dirSuffix}`
      : config.description;
    execSync(`sc.exe description ${config.name} "${descText.replace(/"/g, '\\"')}"`, {
      stdio: 'pipe',
    });

    // Configure auto-start
    execSync(`sc.exe config ${config.name} start= auto`, { stdio: 'pipe' });

    // Configure failure recovery with backoff delays from restart policy
    const delays = config.restartPolicy.delays;
    const actions = delays.map((d) => `restart/${d * 1000}`).join('/');
    const resetSeconds = config.restartPolicy.windowSeconds;
    execSync(`sc.exe failure ${config.name} reset= ${resetSeconds} actions= ${actions}`, {
      stdio: 'pipe',
    });
  }

  async uninstall(config: ServiceConfig): Promise<void> {
    const waitSeconds = stopWaitSeconds(config);

    // Stop first (ignore errors if already stopped), and let the process exit
    // before the delete: shawl gives it the service's whole shutdown grace.
    try {
      execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });
    } catch {
      // Service may already be stopped
    }
    const stopDeadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < stopDeadline) {
      const stateCode = this.queryStateCode(config.name);
      if (stateCode === 1 || stateCode === undefined) break; // STOPPED, or gone
      await sleep(500);
    }

    // Delete the service. If its process has not exited yet, sc.exe delete
    // succeeds but the deletion is deferred until it does. Poll until the
    // service is fully removed to avoid "service already exists" on re-install.
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
    // Wait for the service to fully reach STOPPED state before starting —
    // `sc.exe start` fails with error 1056 if the service is still in
    // STOP_PENDING (code 3), which lasts until the process has shut down. If
    // the service is already RUNNING (code 4), treat `start` as a no-op —
    // calling `sc.exe start` on a running service fails with error 1056
    // ("service already running").
    const deadline = Date.now() + stopWaitSeconds(config) * 1000;
    while (Date.now() < deadline) {
      // A query can fail transiently during state transitions; retry.
      const stateCode = this.queryStateCode(config.name);
      if (stateCode === 4) return; // Already RUNNING — nothing to do
      if (stateCode === 1) break; // STOPPED — proceed to start
      await sleep(500);
    }

    execSync(`sc.exe start ${config.name}`, { stdio: 'pipe' });
  }

  async stop(config: ServiceConfig): Promise<void> {
    try {
      execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });
    } catch (err) {
      // A service that is not running answers 1062, and one that is already
      // stopping answers 1061. STOPPED is the state `stop` asks for, so either
      // succeeds once the query confirms it; a stop still in progress is left
      // to the wait below. Any other failure (access denied, no such service,
      // a service that is starting) still surfaces.
      const status = (err as { status?: unknown })?.status;
      if (status !== ERROR_SERVICE_NOT_ACTIVE && status !== ERROR_SERVICE_CANNOT_ACCEPT_CTRL) {
        throw err;
      }
      const stateCode = this.queryStateCode(config.name);
      if (stateCode === 1) return;
      if (status !== ERROR_SERVICE_CANNOT_ACCEPT_CTRL || stateCode !== 3) throw err;
    }

    // Wait for the service to actually reach STOPPED state before returning.
    // `sc.exe stop` returns immediately after sending the stop control — the
    // service enters STOP_PENDING (code 3) and only reaches STOPPED (code 1)
    // once its process has exited, which shawl allows the whole shutdown
    // grace. A caller that immediately invokes `start` would otherwise hit
    // error 1056.
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
    // Enumerate all kici-* services and their descriptions via WMI. The
    // [KiCI:<component>] description prefix is the discriminator — Windows
    // lacks first-class unit metadata, so the description is the anchor.
    // `isUserLevel` is advisory: the Services Control Manager runs
    // system-wide, but we record the caller's intent on each returned
    // instance so the resolver knows what privilege scope was asked about.
    // A failed registry read is NOT an empty registry. `listInstances` prunes
    // this platform's index rows on the strength of an empty scan, so an `[]`
    // here deletes every windows row on the host the first time WMI hiccups —
    // the same defect the compose driver carried. Both failures are therefore
    // thrown, and `scanDrivers` drops this driver from the scan exactly as it
    // drops one whose `available()` said false.
    let raw: string;
    try {
      // execSync with no `encoding` returns a Buffer; coerce to string so
      // tests that mock with `Buffer.from(...)` and real PowerShell stdout
      // both flow through the same JSON.parse path.
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
    // An empty answer is the one honest `[]`: `ConvertTo-Json` emits nothing
    // when the query matches no service, so the registry answered and holds no
    // KiCI services.
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
    // PowerShell's ConvertTo-Json emits a bare object when a query returns
    // a single row; wrap in [] so the iteration is uniform.
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
   * The command line a service is registered with.
   *
   * `sc.exe qc` answers most registrations, but it fails (error 1734) once the
   * line is longer than about 4000 characters, as an older CLI's registration
   * with every env-file value on it can be. It also prints in the console code
   * page, so a path outside ASCII, such as one under the profile of a user
   * named Jürgen, decodes to U+FFFD. In either case the registry value it reads
   * (`ImagePath`) is read through PowerShell, printed as UTF-8.
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
    // shawl registers `"shawl.exe" run --name <name> ... -- "<exec>" "<arg>" ...`;
    // the real launch command is everything after the first unquoted `--`,
    // which is where shawl itself splits it. A quoted value, such as a --cwd
    // path or an --env value, may hold " -- ".
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
