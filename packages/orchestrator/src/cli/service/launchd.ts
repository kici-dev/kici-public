/**
 * launchd service manager implementation.
 *
 * Generates plist files and manages service lifecycle via launchctl.
 * Supports both system-level (/Library/LaunchDaemons/) and
 * user-level (~/Library/LaunchAgents/) agents.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ServiceConfig,
  ServiceManager,
  ServiceStatus,
  LogOptions,
  DiscoveredInstance,
  LaunchSpec,
} from './types.js';

/** Reverse-DNS label prefix for KiCI services. */
const LABEL_PREFIX = 'dev.kici';

/** Default log directory for system daemons. */
const SYSTEM_LOG_DIR = '/var/log/kici';

/** Async sleep used to pace launchd bootout/bootstrap reconciliation. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LaunchdServiceManager implements ServiceManager {
  /** Build the launchd label for a service. */
  private label(config: ServiceConfig): string {
    return `${LABEL_PREFIX}.${config.name}`;
  }

  /** Resolve the log directory based on service level. */
  private logDir(config: ServiceConfig): string {
    if (config.isUserLevel) {
      return path.join(os.homedir(), 'Library', 'Logs', 'kici');
    }
    return SYSTEM_LOG_DIR;
  }

  /** Resolve the plist file path based on service level. */
  private plistPath(config: ServiceConfig): string {
    const filename = `${this.label(config)}.plist`;
    if (config.isUserLevel) {
      return path.join(os.homedir(), 'Library', 'LaunchAgents', filename);
    }
    return path.join('/Library', 'LaunchDaemons', filename);
  }

  /** Parse a .env file into key-value pairs. */
  private parseEnvFile(envFilePath: string): Map<string, string> {
    const entries = new Map<string, string>();
    try {
      const content = fs.readFileSync(envFilePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          entries.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
        }
      }
    } catch {
      // Env file doesn't exist or isn't readable — no env vars
    }
    return entries;
  }

  /** Escape XML special characters. */
  private escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Inverse of {@link escapeXml} — decode the entities back to literals. */
  private unescapeXml(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }

  /**
   * Generate a launchd plist XML string from a service config.
   * Visible for testing.
   */
  generatePlist(config: ServiceConfig): string {
    const label = this.label(config);
    const logDirectory = this.logDir(config);
    const envVars = this.parseEnvFile(config.envFilePath);

    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push(
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    );
    lines.push('<plist version="1.0">');
    lines.push('<dict>');

    // Label
    lines.push('  <key>Label</key>');
    lines.push(`  <string>${this.escapeXml(label)}</string>`);

    // Component marker read by list() to classify discovered jobs; launchd
    // treats unknown keys as opaque metadata, so this is safe to embed.
    if (config.component) {
      lines.push('  <key>KiCIComponent</key>');
      lines.push(`  <string>${config.component}</string>`);
    }

    // Deploy-folder marker read by list() to recover the instanceDir straight
    // from the plist, making the instance index a rebuildable cache.
    if (config.instanceDir) {
      lines.push('  <key>KiCIInstanceDir</key>');
      lines.push(`  <string>${this.escapeXml(config.instanceDir)}</string>`);
    }

    // ProgramArguments
    lines.push('  <key>ProgramArguments</key>');
    lines.push('  <array>');
    lines.push(`    <string>${this.escapeXml(config.executablePath)}</string>`);
    for (const arg of config.args ?? []) {
      lines.push(`    <string>${this.escapeXml(arg)}</string>`);
    }
    lines.push('  </array>');

    // WorkingDirectory
    lines.push('  <key>WorkingDirectory</key>');
    lines.push(`  <string>${this.escapeXml(config.workingDirectory)}</string>`);

    // RunAtLoad + KeepAlive
    lines.push('  <key>RunAtLoad</key>');
    lines.push('  <true/>');
    lines.push('  <key>KeepAlive</key>');
    lines.push('  <true/>');

    // ThrottleInterval (use first delay from restart policy)
    if (config.restartPolicy.enabled && config.restartPolicy.delays.length > 0) {
      lines.push('  <key>ThrottleInterval</key>');
      lines.push(`  <integer>${config.restartPolicy.delays[0]}</integer>`);
    }

    // Log paths
    lines.push('  <key>StandardOutPath</key>');
    lines.push(
      `  <string>${this.escapeXml(path.join(logDirectory, `${config.name}.out.log`))}</string>`,
    );
    lines.push('  <key>StandardErrorPath</key>');
    lines.push(
      `  <string>${this.escapeXml(path.join(logDirectory, `${config.name}.err.log`))}</string>`,
    );

    // UserName for system daemons
    if (!config.isUserLevel && config.user) {
      lines.push('  <key>UserName</key>');
      lines.push(`  <string>${this.escapeXml(config.user)}</string>`);
    }

    // Prepend the node bin dir to PATH. launchd starts daemons with a minimal
    // default PATH that omits non-standard node installs (mise/nvm/homebrew, or
    // the kici-managed cached node). The bare-metal scaler spawns the kici-agent
    // node script as a child of this process; without node on PATH the
    // required-tools check refuses to start. Prefer the install-resolved
    // nodeBinDir (the node running the install command) — when the service is
    // installed with --binary, executablePath is a wrapper, not node, so its
    // dirname is the wrong directory. Mirrors systemd.ts's Environment=PATH.
    const nodeBinDir = config.nodeBinDir ?? path.dirname(config.executablePath);
    const macosDefaultPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const envFilePathValue = envVars.get('PATH');
    envVars.set('PATH', `${nodeBinDir}:${envFilePathValue ?? macosDefaultPath}`);

    // EnvironmentVariables (always present — at minimum carries PATH)
    lines.push('  <key>EnvironmentVariables</key>');
    lines.push('  <dict>');
    for (const [key, value] of envVars) {
      lines.push(`    <key>${this.escapeXml(key)}</key>`);
      lines.push(`    <string>${this.escapeXml(value)}</string>`);
    }
    lines.push('  </dict>');

    lines.push('</dict>');
    lines.push('</plist>');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Resolve the launchctl domain string for a service config.
   *
   *   - User-level (LaunchAgent at `~/Library/LaunchAgents/…`) → `gui/<uid>`
   *   - System-level (LaunchDaemon at `/Library/LaunchDaemons/…`) → `system`
   *
   * The legacy `launchctl load` / `unload` verbs implicitly inferred the
   * domain from the plist's filesystem location, but they fail silently on
   * headless macOS hosts where no GUI session exists (the `gui/<uid>` domain
   * is not available without a console login). The modern `bootstrap` /
   * `bootout` / `kickstart` / `kill` verbs take the domain explicitly, so a
   * system-level LaunchDaemon loads regardless of whether anyone is logged
   * in at the console — exactly what we need for headless deploy targets.
   */
  private domain(config: ServiceConfig): string {
    return config.isUserLevel ? `gui/${os.userInfo().uid}` : 'system';
  }

  /** `<domain>/<label>` — the target string for kickstart/kill/print/enable. */
  private domainTarget(config: ServiceConfig): string {
    return `${this.domain(config)}/${this.label(config)}`;
  }

  /** Is the service currently loaded in its target domain? */
  private isLoaded(config: ServiceConfig): boolean {
    try {
      execFileSync('launchctl', ['print', this.domainTarget(config)], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async install(config: ServiceConfig): Promise<void> {
    const plistFile = this.plistPath(config);
    const plistContent = this.generatePlist(config);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(plistFile), { recursive: true });

    // Ensure log directory exists
    const logDirectory = this.logDir(config);
    fs.mkdirSync(logDirectory, { recursive: true });

    // System-level LaunchDaemons run as `UserName` (from the plist) but the
    // log dir was just created by the installing user (root, since system
    // install needs sudo). launchd opens StandardOutPath / StandardErrorPath
    // as the spawned-user identity, so the dir must be writable by that
    // user — otherwise the daemon fails to spawn with no log output at all
    // ("state = spawn scheduled" forever). Chown recursively so prior runs'
    // log files also become writable. No-op when the dir is already correct.
    if (!config.isUserLevel && config.user) {
      execFileSync('chown', ['-R', `${config.user}:staff`, logDirectory], { stdio: 'inherit' });
    }

    // Write plist file
    fs.writeFileSync(plistFile, plistContent, 'utf-8');

    // If a previous instance is already loaded in the target domain, bootout
    // first so bootstrap doesn't fail with exit code 5 ("Service is already
    // loaded"). Idempotent: bootout on a not-loaded service returns 113
    // which we swallow. `launchctl bootout` returns before launchd has
    // finished the (asynchronous) teardown, so we then wait for the service
    // to actually leave its domain before bootstrapping — bootstrapping into
    // a domain that's still tearing down a same-named service fails with EIO
    // ("5: Input/output error").
    if (this.isLoaded(config)) {
      try {
        execFileSync('launchctl', ['bootout', this.domainTarget(config)], { stdio: 'inherit' });
      } catch {
        // Already gone, or in a weird state — the wait + bootstrap below will
        // surface the real error if it still can't proceed.
      }
      await this.waitUntilUnloaded(config);
    }

    // Bootstrap into the explicit domain. This is the modern equivalent of
    // `launchctl load`; the key difference is the explicit `gui/<uid>` /
    // `system` argument that decouples the call from any console session.
    // Retried with backoff to absorb the residual EIO race that launchd can
    // still raise immediately after a same-named service is unloaded.
    await this.bootstrapWithRetry(config, plistFile);
  }

  /**
   * Poll until the service is no longer loaded in its target domain, or a
   * short deadline elapses. `launchctl bootout` is asynchronous — it returns
   * before launchd has finished releasing the service — so a bootstrap issued
   * immediately afterward races the teardown and fails with EIO. Waiting for
   * the unload to complete closes that race for the common case; the residual
   * window is covered by bootstrapWithRetry.
   */
  private async waitUntilUnloaded(config: ServiceConfig): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (this.isLoaded(config)) {
      if (Date.now() >= deadline) return; // give up; the bootstrap retry handles it
      await sleep(500);
    }
  }

  /**
   * Bootstrap into the target domain, retrying on the transient EIO
   * ("5: Input/output error") launchd returns when a just-removed service has
   * not finished tearing down. A genuine, non-transient failure (bad plist,
   * permission denied) is re-thrown on the first attempt. If a stale instance
   * reappears between attempts, it is booted out before the next try.
   */
  private async bootstrapWithRetry(config: ServiceConfig, plistFile: string): Promise<void> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        execFileSync('launchctl', ['bootstrap', this.domain(config), plistFile], {
          stdio: ['inherit', 'inherit', 'pipe'],
        });
        return;
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer | string };
        const stderr = (e.stderr ?? '').toString();
        const transient = e.status === 5 || /input\/output error|resource busy/i.test(stderr);
        if (!transient || attempt === attempts) {
          if (stderr) process.stderr.write(stderr);
          throw err;
        }
        // A stale instance may have re-materialised — clear it before retry.
        if (this.isLoaded(config)) {
          try {
            execFileSync('launchctl', ['bootout', this.domainTarget(config)], { stdio: 'inherit' });
          } catch {
            // Best-effort; the next bootstrap attempt surfaces any real error.
          }
        }
        await sleep(1_000 * attempt);
      }
    }
  }

  async uninstall(config: ServiceConfig): Promise<void> {
    const plistFile = this.plistPath(config);

    // Bootout from the target domain (ignore errors if not loaded).
    try {
      execFileSync('launchctl', ['bootout', this.domainTarget(config)], { stdio: 'inherit' });
    } catch {
      // Not loaded — nothing to unload.
    }

    // Remove plist file
    try {
      fs.unlinkSync(plistFile);
    } catch {
      // Already gone — uninstall is idempotent.
    }
  }

  async start(config: ServiceConfig): Promise<void> {
    // `kickstart -k` is the modern equivalent of `launchctl start <label>`:
    // it sends a start signal to the named service in the explicit domain,
    // killing the running instance first (`-k`) so a stuck process doesn't
    // wedge the restart. Works on both LaunchAgents and LaunchDaemons.
    execFileSync('launchctl', ['kickstart', '-k', this.domainTarget(config)], {
      stdio: 'inherit',
    });
  }

  async stop(config: ServiceConfig): Promise<void> {
    // `kill TERM` is the modern equivalent of `launchctl stop <label>`:
    // sends SIGTERM to the service's running PID in the explicit domain. The
    // KeepAlive policy will respawn unless the caller has already booted
    // out the service (which is what uninstall does).
    execFileSync('launchctl', ['kill', 'TERM', this.domainTarget(config)], {
      stdio: 'inherit',
    });
  }

  async restart(config: ServiceConfig): Promise<void> {
    await this.stop(config);
    await this.start(config);
  }

  async status(config: ServiceConfig): Promise<ServiceStatus> {
    const label = this.label(config);

    try {
      // launchctl list outputs lines: PID\tExitCode\tLabel
      const output = execFileSync('launchctl', ['list'], { encoding: 'utf-8' });

      for (const line of output.split('\n')) {
        if (!line.includes(label)) continue;
        const parts = line.trim().split('\t');
        if (parts.length >= 3) {
          const pidStr = parts[0];
          const exitCode = parseInt(parts[1], 10);
          const pid = pidStr !== '-' ? parseInt(pidStr, 10) : undefined;

          if (pid && pid > 0) {
            return { state: 'running', pid };
          }
          if (exitCode !== 0) {
            return { state: 'failed' };
          }
          return { state: 'stopped' };
        }
      }
    } catch {
      // launchctl failed
    }

    return { state: 'unknown' };
  }

  async logs(config: ServiceConfig, options: LogOptions): Promise<void> {
    const logDirectory = this.logDir(config);
    const outLog = path.join(logDirectory, `${config.name}.out.log`);
    const errLog = path.join(logDirectory, `${config.name}.err.log`);

    const args: string[] = [];

    if (options.follow) {
      args.push('-f');
    }

    // Default to last 100 lines
    if (!options.follow) {
      args.push('-n', '100');
    }

    args.push(outLog, errLog);

    return new Promise<void>((resolve, reject) => {
      const child = spawn('tail', args, { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`tail exited with code ${code}`));
        }
      });
    });
  }

  async isInstalled(config: ServiceConfig): Promise<boolean> {
    return fs.existsSync(this.plistPath(config));
  }

  async list(isUserLevel: boolean): Promise<DiscoveredInstance[]> {
    const baseDir = isUserLevel
      ? path.join(os.homedir(), 'Library', 'LaunchAgents')
      : '/Library/LaunchDaemons';
    if (!fs.existsSync(baseDir)) return [];

    // Filename filter is `.plist` only — KiCI launchd labels use reverse-DNS
    // (`com.kici.<name>` / `dev.kici.<name>`), so there's no single shared
    // prefix to filter on. The marker IS the discriminator: scan every plist
    // in the dir and let the KiCIComponent regex classify each entry.
    const out: DiscoveredInstance[] = [];
    for (const entry of fs.readdirSync(baseDir)) {
      if (typeof entry !== 'string') continue;
      if (!entry.endsWith('.plist')) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(baseDir, entry), 'utf-8');
      } catch {
        continue; // File removed mid-scan or perms changed; skip cleanly.
      }
      const match = content.match(
        /<key>KiCIComponent<\/key>\s*<string>(orchestrator|agent)<\/string>/,
      );
      if (!match) continue;
      const dirMatch = content.match(/<key>KiCIInstanceDir<\/key>\s*<string>([^<]+)<\/string>/);
      out.push({
        name: entry.replace(/\.plist$/, ''),
        platform: 'launchd',
        isUserLevel,
        component: match[1] as 'orchestrator' | 'agent',
        instanceDir: dirMatch ? this.unescapeXml(dirMatch[1]) : undefined,
      });
    }
    return out;
  }

  async readLaunchSpec(config: ServiceConfig): Promise<LaunchSpec | null> {
    let content: string;
    try {
      content = fs.readFileSync(this.plistPath(config), 'utf-8');
    } catch {
      return null;
    }
    const arr = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!arr) return null;
    const strings = [...arr[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) =>
      this.unescapeXml(s[1]!),
    );
    if (strings.length === 0) return null;
    return { execPath: strings[0]!, args: strings.slice(1) };
  }
}
