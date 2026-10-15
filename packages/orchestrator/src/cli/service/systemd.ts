/**
 * systemd service manager: system-level (/etc/systemd/system/) and user-level
 * (~/.config/systemd/user/) units, driven through systemctl, journalctl and
 * loginctl.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredInstance,
  ServiceConfig,
  ServiceManager,
  ServiceStatus,
  LogOptions,
  LaunchSpec,
} from './types.js';

/**
 * Whether linger is enabled, via `loginctl show-user` (readable by any user).
 * False on any failure (parse, missing binary, unknown user), in which case
 * the caller attempts `enable-linger`. Exported for testing.
 */
export function isLingerEnabled(user: string): boolean {
  try {
    const out = execFileSync('loginctl', ['show-user', user, '--property=Linger'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /^Linger=yes$/m.test(out.trim());
  } catch {
    return false;
  }
}

/** Log level to systemd priority. */
const PRIORITY_MAP: Record<string, string> = {
  error: '3',
  warn: '4',
  info: '6',
};

export class SystemdServiceManager implements ServiceManager {
  readonly platform = 'systemd' as const;

  /** Visible for testing. */
  generateUnitFile(config: ServiceConfig): string {
    const lines: string[] = [];

    lines.push('[Unit]');
    lines.push(`Description=${config.description}`);
    // Lets `list()` classify the unit without relying on its name. systemd
    // treats unknown `X-*` directives as opaque metadata.
    if (config.component) {
      lines.push(`X-KiCI-Component=${config.component}`);
    }
    // Lets `list()` recover the instanceDir, so the instance index is a rebuildable cache.
    if (config.instanceDir) {
      lines.push(`X-KiCI-InstanceDir=${config.instanceDir}`);
    }
    lines.push('After=network.target postgresql.service');
    // StartLimit* are [Unit] directives: a `StartLimitIntervalSec=` in
    // [Service] is ignored with an "Unknown key" warning and the window falls
    // back to the manager-wide default.
    if (config.restartPolicy.enabled) {
      lines.push(`StartLimitBurst=${config.restartPolicy.maxRetries}`);
      lines.push(`StartLimitIntervalSec=${config.restartPolicy.windowSeconds}`);
    }
    lines.push('');

    lines.push('[Service]');
    lines.push('Type=simple');
    const execArgs = config.args?.length ? ` ${config.args.join(' ')}` : '';
    lines.push(`ExecStart=${config.executablePath}${execArgs}`);
    lines.push(`EnvironmentFile=${config.envFilePath}`);
    // systemd's minimal PATH omits non-standard node installs (mise/nvm/asdf,
    // the kici-managed node), and the bare-metal scaler's kici-agent child
    // needs node on PATH or the required-tools check refuses to start.
    // nodeBinDir wins because with --binary, executablePath is a wrapper.
    const nodeBinDir = config.nodeBinDir ?? path.dirname(config.executablePath);
    lines.push(`Environment=PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
    lines.push(`WorkingDirectory=${config.workingDirectory}`);

    if (!config.isUserLevel && config.user) {
      lines.push(`User=${config.user}`);
      lines.push(`Group=${config.user}`);
    }

    // The StartLimit* bound on these restarts is in [Unit].
    if (config.restartPolicy.enabled) {
      lines.push('Restart=on-failure');
      lines.push(`RestartSec=${config.restartPolicy.delays[0]}s`);
    }

    // System-level only: user services lack the privileges.
    if (!config.isUserLevel) {
      lines.push('');
      lines.push('# Security hardening');
      lines.push('NoNewPrivileges=true');
      lines.push('ProtectSystem=strict');
      lines.push('ProtectHome=read-only');
      lines.push(`ReadWritePaths=${config.workingDirectory}`);
      lines.push('LimitNOFILE=65536');
    }

    lines.push('');

    lines.push('[Install]');
    lines.push(config.isUserLevel ? 'WantedBy=default.target' : 'WantedBy=multi-user.target');
    lines.push('');

    return lines.join('\n');
  }

  private unitFilePath(config: ServiceConfig): string {
    if (config.isUserLevel) {
      return path.join(os.homedir(), '.config', 'systemd', 'user', `${config.name}.service`);
    }
    return `/etc/systemd/system/${config.name}.service`;
  }

  private systemctlArgs(config: ServiceConfig, ...args: string[]): string[] {
    return config.isUserLevel ? ['--user', ...args] : args;
  }

  private systemctl(config: ServiceConfig, ...args: string[]): void {
    execFileSync('systemctl', this.systemctlArgs(config, ...args), { stdio: 'inherit' });
  }

  async install(config: ServiceConfig): Promise<void> {
    const unitPath = this.unitFilePath(config);
    const unitContent = this.generateUnitFile(config);

    fs.mkdirSync(path.dirname(unitPath), { recursive: true });

    fs.writeFileSync(unitPath, unitContent, 'utf-8');

    this.systemctl(config, 'daemon-reload');
    this.systemctl(config, 'enable', config.name);

    // Linger keeps user-level services alive after logout. `enable-linger`
    // needs root or polkit for another user, and on some distros (Debian
    // trixie) fails with "Access denied" even for the current user without an
    // interactive polkit prompt, so skip it when linger is already on.
    if (config.isUserLevel) {
      const user = config.user || os.userInfo().username;
      if (isLingerEnabled(user)) {
        // Already enabled.
      } else {
        try {
          execFileSync('loginctl', ['enable-linger', user], { stdio: 'inherit' });
        } catch (err) {
          throw new Error(
            `Failed to enable linger for user "${user}" via \`loginctl enable-linger\`. ` +
              `This requires root/polkit privileges on some distros. ` +
              `Run \`sudo loginctl enable-linger ${user}\` on the target machine and retry. ` +
              `Underlying error: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  async uninstall(config: ServiceConfig): Promise<void> {
    try {
      this.systemctl(config, 'stop', config.name);
    } catch {
      // Service may not be running
    }
    try {
      this.systemctl(config, 'disable', config.name);
    } catch {
      // Service may not be enabled
    }

    const unitPath = this.unitFilePath(config);
    fs.unlinkSync(unitPath);

    this.systemctl(config, 'daemon-reload');
  }

  async start(config: ServiceConfig): Promise<void> {
    this.systemctl(config, 'start', config.name);
  }

  async stop(config: ServiceConfig): Promise<void> {
    this.systemctl(config, 'stop', config.name);
  }

  async restart(config: ServiceConfig): Promise<void> {
    this.systemctl(config, 'restart', config.name);
  }

  async status(config: ServiceConfig): Promise<ServiceStatus> {
    const output = execFileSync(
      'systemctl',
      this.systemctlArgs(
        config,
        'show',
        config.name,
        '--property=ActiveState,MainPID,ExecMainStartTimestamp',
      ),
      { encoding: 'utf-8' },
    );

    const props = new Map<string, string>();
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        props.set(line.slice(0, idx), line.slice(idx + 1).trim());
      }
    }

    const activeState = props.get('ActiveState') || '';
    const mainPid = parseInt(props.get('MainPID') || '0', 10);
    const startTimestamp = props.get('ExecMainStartTimestamp') || '';

    let state: ServiceStatus['state'];
    switch (activeState) {
      case 'active':
        state = 'running';
        break;
      case 'inactive':
        state = 'stopped';
        break;
      case 'failed':
        state = 'failed';
        break;
      default:
        state = 'unknown';
    }

    const status: ServiceStatus = { state };

    if (mainPid > 0) {
      status.pid = mainPid;
    }

    if (startTimestamp) {
      try {
        const parsed = new Date(startTimestamp);
        if (!isNaN(parsed.getTime())) {
          status.startedAt = parsed.toISOString();
          if (state === 'running') {
            status.uptime = Math.floor((Date.now() - parsed.getTime()) / 1000);
          }
        }
      } catch {
        // Ignore unparseable timestamps
      }
    }

    return status;
  }

  async logs(config: ServiceConfig, options: LogOptions): Promise<void> {
    const args: string[] = [];

    if (config.isUserLevel) {
      args.push('--user-unit', config.name);
    } else {
      args.push('-u', config.name);
    }

    if (options.since) {
      args.push('--since', `${options.since} ago`);
    }

    if (options.level && PRIORITY_MAP[options.level]) {
      args.push('--priority', PRIORITY_MAP[options.level]);
    }

    if (options.json) {
      args.push('--output', 'json');
    }

    if (options.follow) {
      args.push('-f');
    }

    return new Promise<void>((resolve, reject) => {
      const child = spawn('journalctl', args, { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`journalctl exited with code ${code}`));
        }
      });
    });
  }

  async isInstalled(config: ServiceConfig): Promise<boolean> {
    return fs.existsSync(this.unitFilePath(config));
  }

  async readLaunchSpec(config: ServiceConfig): Promise<LaunchSpec | null> {
    let content: string;
    try {
      content = fs.readFileSync(this.unitFilePath(config), 'utf-8');
    } catch {
      return null;
    }
    const m = content.match(/^ExecStart=(.+?)\s*$/m);
    if (!m) return null;
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    return { execPath: tokens[0]!, args: tokens.slice(1) };
  }

  async list(isUserLevel: boolean): Promise<DiscoveredInstance[]> {
    const unitDir = isUserLevel
      ? path.join(os.homedir(), '.config', 'systemd', 'user')
      : '/etc/systemd/system';
    if (!fs.existsSync(unitDir)) return [];

    const out: DiscoveredInstance[] = [];
    for (const entry of fs.readdirSync(unitDir)) {
      if (typeof entry !== 'string') continue;
      if (!entry.startsWith('kici-') || !entry.endsWith('.service')) continue;
      const content = fs.readFileSync(path.join(unitDir, entry), 'utf-8');
      const m = content.match(/^X-KiCI-Component=(orchestrator|agent)\s*$/m);
      if (!m) continue;
      const dirMatch = content.match(/^X-KiCI-InstanceDir=(.+?)\s*$/m);
      out.push({
        name: entry.replace(/\.service$/, ''),
        platform: 'systemd',
        isUserLevel,
        component: m[1] as 'orchestrator' | 'agent',
        instanceDir: dirMatch?.[1],
      });
    }
    return out;
  }
}
