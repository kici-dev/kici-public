/**
 * launchd service manager: writes plists and drives launchctl, for system-level
 * (/Library/LaunchDaemons/) and user-level (~/Library/LaunchAgents/) jobs.
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
 * Label prefixes discovery recognises. `com.kici` is the historical one, and
 * hosts upgraded across the rename carry both.
 */
const KNOWN_LABEL_PREFIXES = ['dev.kici.', 'com.kici.'] as const;

/**
 * `dev.kici.my-orch` -> `my-orch`. A label with no known prefix returns
 * unchanged, so a hand-written plist stays discoverable.
 */
export function stripLabelPrefix(label: string): string {
  for (const prefix of KNOWN_LABEL_PREFIXES) {
    if (label.startsWith(prefix)) return label.slice(prefix.length);
  }
  return label;
}

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
 * How long `stop` waits for the job to leave the domain after a failed bootout,
 * covering a concurrent unload launchd is still finishing.
 */
const FAILED_BOOTOUT_SETTLE_MS = 5_000;

export class LaunchdServiceManager implements ServiceManager {
  readonly platform = 'launchd' as const;

  private label(config: ServiceConfig): string {
    return `${LABEL_PREFIX}.${config.name}`;
  }

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
   * A job for this name under another label (`com.kici.<name>`, or a plist named
   * after the service), which `list()` reports as this instance. Only a plist
   * with the KiCI component marker counts; the job is addressed by its declared Label.
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
   * The job a lifecycle command acts on: the installed `dev.kici.<name>` plist,
   * else an other-label job, so every instance `list()` reports stays
   * manageable. With neither installed, the `dev.kici.<name>` job.
   */
  private resolveJob(config: ServiceConfig): LaunchdJob {
    const job = this.installJob(config);
    if (fs.existsSync(job.plistPath)) return job;
    return this.otherLabelJob(config) ?? job;
  }

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
      // Missing or unreadable env file: no env vars.
    }
    return entries;
  }

  private escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Inverse of {@link escapeXml}. */
  private unescapeXml(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }

  /** Visible for testing. */
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

    lines.push('  <key>Label</key>');
    lines.push(`  <string>${this.escapeXml(label)}</string>`);

    // list() classifies jobs by this marker; launchd ignores unknown keys.
    if (config.component) {
      lines.push('  <key>KiCIComponent</key>');
      lines.push(`  <string>${config.component}</string>`);
    }

    // list() recovers the instanceDir from this marker, so the instance index
    // is a rebuildable cache.
    if (config.instanceDir) {
      lines.push('  <key>KiCIInstanceDir</key>');
      lines.push(`  <string>${this.escapeXml(config.instanceDir)}</string>`);
    }

    lines.push('  <key>ProgramArguments</key>');
    lines.push('  <array>');
    lines.push(`    <string>${this.escapeXml(config.executablePath)}</string>`);
    for (const arg of config.args ?? []) {
      lines.push(`    <string>${this.escapeXml(arg)}</string>`);
    }
    lines.push('  </array>');

    lines.push('  <key>WorkingDirectory</key>');
    lines.push(`  <string>${this.escapeXml(config.workingDirectory)}</string>`);

    lines.push('  <key>RunAtLoad</key>');
    lines.push('  <true/>');

    // SIGTERM-to-SIGKILL wait on unload; launchd's default is shorter than the
    // service's graceful-shutdown budget.
    lines.push('  <key>ExitTimeOut</key>');
    lines.push(`  <integer>${shutdownGraceSeconds(config)}</integer>`);

    // As systemd's Restart=on-failure: restart on a non-zero exit or a signal
    // kill; exit 0 (a stop, an agent drain) stays down. ThrottleInterval spaces
    // restarts by the policy's first delay.
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

    lines.push('  <key>StandardOutPath</key>');
    lines.push(
      `  <string>${this.escapeXml(path.join(logDirectory, `${config.name}.out.log`))}</string>`,
    );
    lines.push('  <key>StandardErrorPath</key>');
    lines.push(
      `  <string>${this.escapeXml(path.join(logDirectory, `${config.name}.err.log`))}</string>`,
    );

    if (!config.isUserLevel && config.user) {
      lines.push('  <key>UserName</key>');
      lines.push(`  <string>${this.escapeXml(config.user)}</string>`);
    }

    // launchd's minimal default PATH omits non-standard node installs
    // (mise/nvm/homebrew, the kici-managed cached node), and the bare-metal
    // scaler spawns the kici-agent node script as a child: without node on PATH
    // the required-tools check refuses to start. Prefer nodeBinDir (the node
    // running the install): with --binary, executablePath is a wrapper, not
    // node. Mirrors systemd.ts's Environment=PATH.
    const nodeBinDir = config.nodeBinDir ?? path.dirname(config.executablePath);
    const macosDefaultPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    const envFilePathValue = envVars.get('PATH');
    envVars.set('PATH', `${nodeBinDir}:${envFilePathValue ?? macosDefaultPath}`);

    // Always present: it carries at least PATH.
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
   * `gui/<uid>` for a user-level LaunchAgent, `system` for a LaunchDaemon. The
   * legacy `load`/`unload` verbs infer the domain from the plist location and
   * fail silently on a headless host (no `gui/<uid>` domain without a console
   * login); the `bootstrap`/`bootout`/`kickstart`/`print` verbs take it
   * explicitly, so a system daemon loads with nobody logged in.
   */
  private domain(config: ServiceConfig): string {
    return config.isUserLevel ? `gui/${os.userInfo().uid}` : 'system';
  }

  /** `<domain>/<label>` — the target string for bootout/kickstart/print. */
  private domainTarget(config: ServiceConfig, job: LaunchdJob): string {
    return `${this.domain(config)}/${job.label}`;
  }

  /**
   * `launchctl print`: the job description, or null when not loaded. Unlike
   * `launchctl list` (own domain only), it reads a system daemon without root.
   * Any other failure throws, so an uninspectable job never reads as stopped.
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

  private isLoaded(config: ServiceConfig, job: LaunchdJob): boolean {
    return this.printJob(config, job) !== null;
  }

  async install(config: ServiceConfig): Promise<void> {
    const job = this.installJob(config);
    const plistContent = this.generatePlist(config);

    fs.mkdirSync(path.dirname(job.plistPath), { recursive: true });

    const logDirectory = this.logDir(config);
    fs.mkdirSync(logDirectory, { recursive: true });

    // launchd opens the log paths as the plist's UserName, but a sudo install
    // created the dir as root; an unwritable dir leaves the daemon at "state =
    // spawn scheduled" forever with no log output. Recursive, so earlier runs'
    // log files become writable too.
    if (!config.isUserLevel && config.user) {
      execFileSync('chown', ['-R', `${config.user}:staff`, logDirectory], { stdio: 'inherit' });
    }

    // Move an other-label instance to the new job, so one process runs it.
    // Done before the new plist is written: a failed unload leaves the instance
    // on its old plist, where every command still finds it.
    const otherJob = this.otherLabelJob(config);
    if (otherJob) {
      await this.unload(config, otherJob);
      fs.unlinkSync(otherJob.plistPath);
    }

    fs.writeFileSync(job.plistPath, plistContent, 'utf-8');

    // A still-loaded previous instance makes bootstrap fail with EIO ("5:
    // Input/output error"). unload() waits out the teardown (up to the old
    // job's whole ExitTimeOut) and is a no-op when nothing is loaded.
    await this.unload(config, job);

    // Retried with backoff for the residual EIO race launchd can raise right
    // after a same-named service is unloaded.
    await this.bootstrapWithRetry(config, job, { replaceLoaded: true });
  }

  /**
   * True once the job has left its domain, false on timeout. `bootout` returns
   * before launchd releases the job, so an immediate bootstrap fails with EIO;
   * this closes the common case and bootstrapWithRetry the residual window.
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
   * Bootstrap, retrying on the transient EIO launchd returns while a
   * just-removed service tears down; a non-transient failure (bad plist,
   * permission denied) throws at once. An already-loaded job gets the same
   * EIO: with `replaceLoaded` (install) it is booted out before the next try;
   * without it (start), a job another caller loaded meanwhile is the wanted
   * outcome (RunAtLoad started it), so the call succeeds.
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

    // `stop` usually unloaded the job already, so launchctl's error is hidden.
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
    // A stopped service has no loaded job: bootstrap it, and RunAtLoad starts it.
    if (!this.isLoaded(config, job)) {
      await this.bootstrapWithRetry(config, job, { replaceLoaded: false });
      return;
    }
    // `kickstart` leaves a running instance alone, so this is a no-op then.
    execFileSync('launchctl', ['kickstart', this.domainTarget(config, job)], {
      stdio: 'inherit',
    });
  }

  async stop(config: ServiceConfig): Promise<void> {
    // KeepAlive restarts on failure (an older CLI's plist after every exit), so
    // only unloading the job holds. The plist stays, so `start` or the next
    // boot or login loads it again.
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
    // A failed bootout still succeeds if the job leaves the domain: a concurrent
    // stop, or an unload launchd is already finishing.
    if (bootoutError !== undefined) {
      if (await this.waitUntilUnloaded(config, job, FAILED_BOOTOUT_SETTLE_MS)) return;
      const stderr = String((bootoutError as { stderr?: unknown }).stderr ?? '');
      if (stderr) process.stderr.write(stderr);
      throw bootoutError;
    }
    // bootout returns mid-teardown; wait, so a following `start` (`restart`,
    // `upgrade`) bootstraps a fresh job. SIGKILL follows SIGTERM after the
    // plist's ExitTimeOut, or launchd's shorter default for an older plist.
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

    // `stop` unloads the job, so an installed plist with no loaded job is stopped.
    if (description === null) {
      return fs.existsSync(job.plistPath) ? { state: 'stopped' } : { state: 'unknown' };
    }

    // Job properties sit one tab deep; nested blocks repeat keys like `state`
    // deeper. launchd names some exit codes (`last exit code = 78: EX_CONFIG`)
    // and reports a kill as `last terminating signal = …`.
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

    // Labels have no single shared prefix, so scan every plist and let the
    // KiCIComponent marker classify it.
    const out: DiscoveredInstance[] = [];
    for (const entry of fs.readdirSync(baseDir)) {
      if (typeof entry !== 'string') continue;
      if (!entry.endsWith('.plist')) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(baseDir, entry), 'utf-8');
      } catch (err) {
        // A file gone since the readdir is not installed. Any other read failure
        // throws: skipping it would drop a live instance, which `listInstances`
        // prunes from the index. Per the `types.ts` driver contract, an
        // unreadable registry throws, and `scanDrivers` then drops the whole
        // launchd scan, leaving every launchd index row untouched.
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
        // The service name, not the label: callers address an instance by its
        // bare `--name`, and `resolve.ts` matches on equality, so the label
        // would make every post-install command report `not found`.
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
    const userMatch = content.match(/<key>UserName<\/key>\s*<string>([\s\S]*?)<\/string>/);
    const user = userMatch ? this.unescapeXml(userMatch[1]!) : undefined;
    return { execPath: strings[0]!, args: strings.slice(1), ...(user ? { user } : {}) };
  }
}
