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

export class WindowsServiceManager implements ServiceManager {
  async install(config: ServiceConfig): Promise<void> {
    // Download shawl via lazy deps
    const depMeta = getDepMetadata('shawl');
    const cacheDir = getCacheDir();
    const depPath = await ensureDep(depMeta, cacheDir);
    const shawlExe = path.join(depPath, depMeta.extractPath);

    // Ensure env file directory exists
    const envDir = path.dirname(config.envFilePath);
    fs.mkdirSync(envDir, { recursive: true });

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
    ];

    // Shawl's --env flag expects KEY=value pairs, not a file path.
    // Read the env file and pass each variable individually.
    // Special handling for PATH: use --path-prepend instead of --env so shawl
    // correctly prepends to the inherited system PATH (LocalSystem has a minimal
    // PATH that lacks tools like git and bash).
    if (fs.existsSync(config.envFilePath)) {
      const envContent = fs.readFileSync(config.envFilePath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const eqIdx = trimmed.indexOf('=');
          const key = trimmed.slice(0, eqIdx);
          if (key === 'PATH') {
            // Split PATH value into directories and prepend each one.
            // Strip trailing backslashes to avoid escaping the closing quote
            // (same issue as --cwd: "C:\dir\" is parsed as "C:\dir" with escaped quote).
            const dirs = trimmed
              .slice(eqIdx + 1)
              .split(';')
              .filter(Boolean);
            for (const dir of dirs) {
              cmdParts.push('--path-prepend', `"${dir.replace(/\\+$/, '')}"`);
            }
          } else {
            cmdParts.push('--env', `"${trimmed}"`);
          }
        }
      }
    }

    cmdParts.push('--', `"${config.executablePath}"`);
    for (const arg of config.args ?? []) {
      cmdParts.push(`"${arg}"`);
    }
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
    // Stop first (ignore errors if already stopped)
    try {
      execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });
      // Wait for the process to fully exit before attempting delete.
      // Windows services can linger in STOP_PENDING for several seconds.
      await new Promise((r) => setTimeout(r, 3_000));
    } catch {
      // Service may already be stopped
    }

    // Delete the service. If STOP_PENDING, sc.exe delete succeeds but the
    // actual deletion is deferred until the process exits. Poll until the
    // service is fully removed to avoid "service already exists" on re-install.
    execSync(`sc.exe delete ${config.name}`, { stdio: 'pipe' });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        execSync(`sc.exe query ${config.name}`, { stdio: 'pipe' });
        // Still exists — wait with increasing delay
        await new Promise((r) => setTimeout(r, 1_000));
      } catch {
        // Service no longer exists — deletion complete
        return;
      }
    }

    throw new Error(
      `Service ${config.name} still exists after 30s. ` +
        `The process may be hung — check Task Manager and kill manually if needed.`,
    );
  }

  async start(config: ServiceConfig): Promise<void> {
    // Wait for the service to fully reach STOPPED state before starting —
    // `sc.exe start` fails with error 1056 if the service is still in
    // STOP_PENDING (code 3). This matches the wait loop in restart(), but
    // applies to a bare `start` call as well, so test harnesses that stop
    // then start via separate kici-admin invocations do not race with the
    // Windows Service Control Manager. If the service is already RUNNING
    // (code 4), treat `start` as a no-op — calling `sc.exe start` on a
    // running service fails with error 1056 ("service already running").
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let stateCode: number | undefined;
      try {
        stateCode = parseStateCode(
          execSync(`sc.exe query ${config.name}`, { stdio: 'pipe' }).toString(),
        );
      } catch {
        // Query may fail transiently during state transitions; retry.
        stateCode = undefined;
      }
      if (stateCode === 4) return; // Already RUNNING — nothing to do
      if (stateCode === 1) break; // STOPPED — proceed to start
      await new Promise((r) => setTimeout(r, 500));
    }

    execSync(`sc.exe start ${config.name}`, { stdio: 'pipe' });
  }

  async stop(config: ServiceConfig): Promise<void> {
    execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });

    // Wait for the service to actually reach STOPPED state before returning.
    // `sc.exe stop` returns immediately after sending the stop control — the
    // service enters STOP_PENDING (code 3) and only reaches STOPPED (code 1)
    // after its shutdown handler finishes. A caller that immediately invokes
    // `start` will otherwise hit error 1056 (same race that restart() guards).
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let stateCode: number | undefined;
      try {
        stateCode = parseStateCode(
          execSync(`sc.exe query ${config.name}`, { stdio: 'pipe' }).toString(),
        );
      } catch {
        stateCode = undefined;
      }
      if (stateCode === 1) return; // STOPPED
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error(
      `Service ${config.name} did not reach STOPPED state within 30s after sc.exe stop. ` +
        `A subsequent start would fail with error 1056 — the service may be hung.`,
    );
  }

  async restart(config: ServiceConfig): Promise<void> {
    try {
      execSync(`sc.exe stop ${config.name}`, { stdio: 'pipe' });
    } catch {
      // May already be stopped
    }

    // Wait for the service to fully stop before starting — sc.exe start
    // fails with error 1056 if the service is still in STOP_PENDING state.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const stateCode = parseStateCode(
        execSync(`sc.exe query ${config.name}`, { stdio: 'pipe' }).toString(),
      );
      if (stateCode === 1) break; // STOPPED
      await new Promise((r) => setTimeout(r, 500));
    }

    execSync(`sc.exe start ${config.name}`, { stdio: 'pipe' });
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
    let raw: string;
    try {
      // execSync with no `encoding` returns a Buffer; coerce to string so
      // tests that mock with `Buffer.from(...)` and real PowerShell stdout
      // both flow through the same JSON.parse path.
      raw = execSync(
        'powershell -Command "Get-CimInstance Win32_Service -Filter \\"Name LIKE \'kici-%\'\\" | Select-Object Name,Description | ConvertTo-Json"',
        { stdio: 'pipe' },
      ).toString();
    } catch {
      return [];
    }
    if (!raw.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
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

  async readLaunchSpec(config: ServiceConfig): Promise<LaunchSpec | null> {
    let raw: string;
    try {
      raw = execSync(`sc.exe qc ${config.name}`, { stdio: 'pipe' }).toString();
    } catch {
      return null;
    }
    const m = raw.match(/BINARY_PATH_NAME\s*:\s*(.+)/);
    if (!m) return null;
    // shawl registers `"shawl.exe" run --name <name> ... -- "<exec>" "<arg>" ...`;
    // the real launch command is everything after the ` -- ` separator.
    const sep = m[1]!.indexOf(' -- ');
    if (sep === -1) return null;
    const after = m[1]!.slice(sep + 4);
    const tokens = [...after.matchAll(/"([^"]*)"|(\S+)/g)].map((t) => t[1] ?? t[2]!);
    if (tokens.length === 0 || !tokens[0]) return null;
    return { execPath: tokens[0], args: tokens.slice(1) };
  }
}
