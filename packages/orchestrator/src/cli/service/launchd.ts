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
import { shutdownGraceSeconds, stopWaitSeconds } from './shutdown-grace.js';
import type {
  ServiceConfig,
  ServiceManager,
  ServiceStatus,
  LogOptions,
  DiscoveredInstance,
  LaunchSpec,
} from './types.js';
import { sleep } from '@kici-dev/engine';

/** Reverse-DNS label prefix for KiCI services. */
const LABEL_PREFIX = 'dev.kici';

/**
 * Reverse-DNS prefixes a KiCI plist label may carry. `com.kici` is the
 * historical one; both appear on hosts upgraded across that rename, so
 * discovery must recognise either.
 */
const KNOWN_LABEL_PREFIXES = ['dev.kici.', 'com.kici.'] as const;

/**
 * `dev.kici.my-orch` -> `my-orch`. Returns the input unchanged when it carries
 * no known prefix, so a hand-written plist is still discoverable under
 * whatever label it uses.
 */
export function stripLabelPrefix(label: string): string {
  for (const prefix of KNOWN_LABEL_PREFIXES) {
    if (label.startsWith(prefix)) return label.slice(prefix.length);
  }
  return label;
}

/** Default log directory for system daemons. */
const SYSTEM_LOG_DIR = '/var/log/kici';

/** The component marker `generatePlist` embeds, which `list()` classifies a plist by. */
const KICI_COMPONENT_MARKER = /<key>KiCIComponent<\/key>\s*<string>(orchestrator|agent)<\/string>/;

/** A launchd job as installed: the Label launchd knows it by, and its plist. */
interface LaunchdJob {
  label: string;
  plistPath: string;
}

/** `launchctl print` exit code for a job that is not loaded in the domain. */
const PRINT_NO_SUCH_SERVICE = 113;

/** `launchctl print` exit code for a domain that does not exist (no GUI login session). */
const PRINT_NO_SUCH_DOMAIN = 112;

/**
 * How long `stop` waits for the job to leave the domain after a failed
 * bootout, before it reports the failure. Covers a concurrent unload that
 * launchd is still finishing.
 */
const FAILED_BOOTOUT_SETTLE_MS = 5_000;

export class LaunchdServiceManager implements ServiceManager {
  readonly platform = 'launchd' as const;

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

  /** The directory launchd loads this service level's plists from. */
  private plistDir(isUserLevel: boolean): string {
    return isUserLevel
      ? path.join(os.homedir(), 'Library', 'LaunchAgents')
      : path.join('/Library', 'LaunchDaemons');
  }

  /** The job `install` writes: `dev.kici.<name>`. */
  private installJob(config: ServiceConfig): LaunchdJob {
    const label = this.label(config);
    return { label, plistPath: path.join(this.plistDir(config.isUserLevel), `${label}.plist`) };
  }

  /**
   * An installed job for this name under another label: a `com.kici.<name>`
   * plist, or a plist named after the service itself — each one `list()`
   * reports as this instance. Only a plist that carries the KiCI component
   * marker counts, and the job is addressed by the Label the plist declares.
   */
  private otherLabelJob(config: ServiceConfig): LaunchdJob | null {
    const prefixes = [...KNOWN_LABEL_PREFIXES.filter((p) => p !== `${LABEL_PREFIX}.`), ''];
    for (const prefix of prefixes) {
      const stem = `${prefix}${config.name}`;
      if (stripLabelPrefix(stem) !== config.name) continue;
      const plistPath = path.join(this.plistDir(config.isUserLevel), `${stem}.plist`);
      if (!fs.existsSync(plistPath)) continue;
      const content = fs.readFileSync(plistPath, 'utf-8');
      if (!KICI_COMPONENT_MARKER.test(content)) continue;
      const label = content.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
      return { label: label ? this.unescapeXml(label[1]!) : stem, plistPath };
    }
    return null;
  }

  /**
   * The job a lifecycle command acts on: the `dev.kici.<name>` plist when it
   * is installed, otherwise a job this name was installed under with another
   * label, so every instance `list()` reports can be stopped, started and
   * removed. With neither installed, the `dev.kici.<name>` job.
   */
  private resolveJob(config: ServiceConfig): LaunchdJob {
    const job = this.installJob(config);
    if (fs.existsSync(job.plistPath)) return job;
    return this.otherLabelJob(config) ?? job;
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

    lines.push('  <key>RunAtLoad</key>');
    lines.push('  <true/>');

    // ExitTimeOut: how long launchd waits after SIGTERM before it SIGKILLs the
    // process when `stop` unloads the job. Its default is shorter than the
    // service's own graceful-shutdown budget.
    lines.push('  <key>ExitTimeOut</key>');
    lines.push(`  <integer>${shutdownGraceSeconds(config)}</integer>`);

    // The restart policy, as the systemd unit's Restart=on-failure: launchd
    // restarts a process that exits non-zero or that a signal kills. A process
    // that exits 0 (a stop, an agent drain) stays down. ThrottleInterval spaces
    // the restarts by the policy's first delay.
    if (config.restartPolicy.enabled) {
      lines.push('  <key>KeepAlive</key>');
      lines.push('  <dict>');
      lines.push('    <key>SuccessfulExit</key>');
      lines.push('    <false/>');
      lines.push('  </dict>');
      if (config.restartPolicy.delays.length > 0) {
        lines.push('  <key>ThrottleInterval</key>');
        lines.push(`  <integer>${config.restartPolicy.delays[0]}</integer>`);
      }
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
   * `bootout` / `kickstart` / `print` verbs take the domain explicitly, so a
   * system-level LaunchDaemon loads regardless of whether anyone is logged
   * in at the console — exactly what we need for headless deploy targets.
   */
  private domain(config: ServiceConfig): string {
    return config.isUserLevel ? `gui/${os.userInfo().uid}` : 'system';
  }

  /** `<domain>/<label>` — the target string for bootout/kickstart/print. */
  private domainTarget(config: ServiceConfig, job: LaunchdJob): string {
    return `${this.domain(config)}/${job.label}`;
  }

  /**
   * `launchctl print <domain>/<label>`: the job's description while it is
   * loaded, or null when launchd reports it not loaded. Unlike `launchctl
   * list`, which lists only the caller's own domain, this reads a system
   * daemon without root. Any other failure throws, so a job that could not be
   * inspected is never mistaken for a stopped one.
   */
  private printJob(config: ServiceConfig, job: LaunchdJob): string | null {
    try {
      return execFileSync('launchctl', ['print', this.domainTarget(config, job)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === PRINT_NO_SUCH_SERVICE || status === PRINT_NO_SUCH_DOMAIN) return null;
      throw err;
    }
  }

  /** Is the job currently loaded in its target domain? */
  private isLoaded(config: ServiceConfig, job: LaunchdJob): boolean {
    return this.printJob(config, job) !== null;
  }

  async install(config: ServiceConfig): Promise<void> {
    const job = this.installJob(config);
    const plistContent = this.generatePlist(config);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(job.plistPath), { recursive: true });

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

    // An instance installed under another label moves to the new job: the old
    // job is unloaded and its plist removed, so one process runs the instance.
    // This happens before the new plist is written, so an unload that fails
    // leaves the instance on its old plist, where every command still finds it.
    const otherJob = this.otherLabelJob(config);
    if (otherJob) {
      await this.unload(config, otherJob);
      fs.unlinkSync(otherJob.plistPath);
    }

    fs.writeFileSync(job.plistPath, plistContent, 'utf-8');

    // A previous instance still loaded in the target domain makes bootstrap
    // fail with EIO ("5: Input/output error"), so unload it first. unload()
    // waits until launchd has finished the teardown, which can take the old
    // job's whole ExitTimeOut, and does nothing when no instance is loaded.
    await this.unload(config, job);

    // Bootstrap into the explicit domain. This is the modern equivalent of
    // `launchctl load`; the key difference is the explicit `gui/<uid>` /
    // `system` argument that decouples the call from any console session.
    // Retried with backoff to absorb the residual EIO race that launchd can
    // still raise immediately after a same-named service is unloaded.
    await this.bootstrapWithRetry(config, job, { replaceLoaded: true });
  }

  /**
   * Poll until the job is no longer loaded in its target domain, or the
   * deadline elapses. Resolves true once the job has left the domain,
   * false on timeout. `launchctl bootout` is asynchronous — it returns before
   * launchd has finished releasing the job — so a bootstrap issued
   * immediately afterward races the teardown and fails with EIO. Waiting for
   * the unload to complete closes that race for the common case; the residual
   * window is covered by bootstrapWithRetry.
   */
  private async waitUntilUnloaded(
    config: ServiceConfig,
    job: LaunchdJob,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isLoaded(config, job)) {
      if (Date.now() >= deadline) return false;
      await sleep(500);
    }
    return true;
  }

  /**
   * Bootstrap into the target domain, retrying on the transient EIO
   * ("5: Input/output error") launchd returns when a just-removed service has
   * not finished tearing down. A genuine, non-transient failure (bad plist,
   * permission denied) is re-thrown on the first attempt.
   *
   * launchd answers a bootstrap of a job that is already loaded with the same
   * EIO. With `replaceLoaded` (install, which just wrote a new plist) such a
   * job is booted out before the next try. Without it (start), a job that
   * another caller loaded meanwhile is the outcome start wanted: RunAtLoad has
   * started it, so the call succeeds and leaves it running.
   */
  private async bootstrapWithRetry(
    config: ServiceConfig,
    job: LaunchdJob,
    opts: { replaceLoaded: boolean },
  ): Promise<void> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        execFileSync('launchctl', ['bootstrap', this.domain(config), job.plistPath], {
          stdio: ['inherit', 'inherit', 'pipe'],
        });
        return;
      } catch (err) {
        if (!opts.replaceLoaded && this.isLoaded(config, job)) return;
        const e = err as { status?: number; stderr?: Buffer | string };
        const stderr = (e.stderr ?? '').toString();
        const transient = e.status === 5 || /input\/output error|resource busy/i.test(stderr);
        if (!transient || attempt === attempts) {
          if (stderr) process.stderr.write(stderr);
          throw err;
        }
        // A stale instance may have re-materialised — clear it before retry.
        if (opts.replaceLoaded && this.isLoaded(config, job)) {
          try {
            execFileSync('launchctl', ['bootout', this.domainTarget(config, job)], {
              stdio: 'inherit',
            });
          } catch {
            // Best-effort; the next bootstrap attempt surfaces any real error.
          }
        }
        await sleep(1_000 * attempt);
      }
    }
  }

  async uninstall(config: ServiceConfig): Promise<void> {
    const job = this.resolveJob(config);

    // Bootout from the target domain. The job is usually not loaded any more
    // (`stop` unloads it), so launchctl's error is not shown.
    try {
      execFileSync('launchctl', ['bootout', this.domainTarget(config, job)], {
        stdio: ['inherit', 'inherit', 'pipe'],
      });
    } catch {
      // Not loaded — nothing to unload.
    }

    try {
      fs.unlinkSync(job.plistPath);
    } catch {
      // Already gone — uninstall is idempotent.
    }
  }

  async start(config: ServiceConfig): Promise<void> {
    const job = this.resolveJob(config);
    // `stop` unloads the job, so a stopped service has no job in its domain:
    // bootstrap the installed plist, and RunAtLoad starts the process.
    if (!this.isLoaded(config, job)) {
      await this.bootstrapWithRetry(config, job, { replaceLoaded: false });
      return;
    }
    // A loaded job: `kickstart` starts it when it is not running and leaves a
    // running instance alone, so `start` on a running service is a no-op.
    execFileSync('launchctl', ['kickstart', this.domainTarget(config, job)], {
      stdio: 'inherit',
    });
  }

  async stop(config: ServiceConfig): Promise<void> {
    // KeepAlive restarts a process that exits non-zero or that a signal kills,
    // and a plist from an older CLI restarts it after every exit. Unloading
    // the job (`bootout`) is the stop that holds however the process exits.
    // The plist stays on disk, so `start`, or the next boot or login, loads it
    // again.
    const job = this.resolveJob(config);
    if (!this.isLoaded(config, job) && !fs.existsSync(job.plistPath)) {
      throw new Error(
        `launchd job ${job.label} is not installed: no job is loaded and ` +
          `${job.plistPath} does not exist.`,
      );
    }
    await this.unload(config, job);
  }

  /**
   * Boot the job out of its domain and wait until launchd has finished the
   * teardown. Does nothing when no job is loaded.
   */
  private async unload(config: ServiceConfig, job: LaunchdJob): Promise<void> {
    if (!this.isLoaded(config, job)) return;
    let bootoutError: unknown;
    try {
      execFileSync('launchctl', ['bootout', this.domainTarget(config, job)], {
        stdio: ['inherit', 'inherit', 'pipe'],
      });
    } catch (err) {
      bootoutError = err;
    }
    // A failed bootout succeeds only if the job leaves the domain anyway: a
    // concurrent stop unloaded it between the check and the call, or launchd
    // is finishing an unload that was already in progress.
    if (bootoutError !== undefined) {
      if (await this.waitUntilUnloaded(config, job, FAILED_BOOTOUT_SETTLE_MS)) return;
      const stderr = String((bootoutError as { stderr?: unknown }).stderr ?? '');
      if (stderr) process.stderr.write(stderr);
      throw bootoutError;
    }
    // bootout returns while launchd is still stopping the process. Return only
    // once the job has left the domain, so a `start` that follows (`restart`,
    // `upgrade`) bootstraps a fresh job instead of racing the teardown.
    // launchd sends SIGTERM, then SIGKILL once the plist's ExitTimeOut elapses;
    // a plist written before that key existed uses launchd's shorter default.
    const timeoutSeconds = stopWaitSeconds(config);
    if (!(await this.waitUntilUnloaded(config, job, timeoutSeconds * 1000))) {
      throw new Error(
        `launchd job ${job.label} is still loaded ${timeoutSeconds}s after ` +
          `launchctl bootout. Its process may be hung — inspect it with ` +
          `\`launchctl print ${this.domainTarget(config, job)}\`.`,
      );
    }
  }

  async restart(config: ServiceConfig): Promise<void> {
    await this.stop(config);
    await this.start(config);
  }

  async status(config: ServiceConfig): Promise<ServiceStatus> {
    const job = this.resolveJob(config);
    let description: string | null;
    try {
      description = this.printJob(config, job);
    } catch {
      return { state: 'unknown' };
    }

    // Not loaded. `stop` unloads the job, so an installed plist with no job in
    // the domain is a stopped service.
    if (description === null) {
      return fs.existsSync(job.plistPath) ? { state: 'stopped' } : { state: 'unknown' };
    }

    // The job's own properties sit one tab deep; nested blocks (endpoints,
    // sockets) repeat keys such as `state` at deeper indentation.
    // launchd names some exit codes (`last exit code = 78: EX_CONFIG`) and
    // reports a signal instead of an exit code (`last terminating signal = …`).
    const pid = description.match(/^\tpid = (\d+)$/m);
    if (pid) return { state: 'running', pid: parseInt(pid[1]!, 10) };
    const lastExit = description.match(/^\tlast exit code = (-?\d+)/m);
    if (lastExit && parseInt(lastExit[1]!, 10) !== 0) return { state: 'failed' };
    if (/^\tlast terminating signal = /m.test(description)) return { state: 'failed' };
    return { state: 'stopped' };
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
    return fs.existsSync(this.resolveJob(config).plistPath);
  }

  async list(isUserLevel: boolean): Promise<DiscoveredInstance[]> {
    const baseDir = this.plistDir(isUserLevel);
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
      } catch (err) {
        // A file that vanished between the readdir and the read is genuinely
        // not installed, so skipping it is the honest answer. Any OTHER read
        // failure — a perms change, an I/O error — is a plist we could not
        // read, and skipping THAT drops a live instance from the scan, which
        // `listInstances` then prunes from the index. So it is thrown: the
        // driver contract in `types.ts` says a registry it cannot read must
        // throw rather than under-report, and `scanDrivers` drops the whole
        // launchd scan (leaving every launchd index row untouched) instead.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        throw new Error(
          `could not read the launchd job at ${path.join(baseDir, entry)}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      const match = content.match(KICI_COMPONENT_MARKER);
      if (!match) continue;
      const dirMatch = content.match(/<key>KiCIInstanceDir<\/key>\s*<string>([^<]+)<\/string>/);
      out.push({
        // Report the SERVICE name, not the launchd label. The label is
        // reverse-DNS (`dev.kici.<name>`), but every caller addresses an
        // instance by the bare name it installed under — `--name <name>` —
        // and `resolve.ts` matches on equality. Reporting the label made
        // every post-install command on macOS answer `not found. Installed:
        // - dev.kici.<name>`, listing the very instance it declined to match.
        name: stripLabelPrefix(entry.replace(/\.plist$/, '')),
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
      content = fs.readFileSync(this.resolveJob(config).plistPath, 'utf-8');
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
