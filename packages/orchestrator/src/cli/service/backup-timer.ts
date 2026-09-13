/**
 * Scheduled orchestrator database backups.
 *
 * Renders and registers a `kici-<instance>-db-backup` service + timer pair that
 * runs `kici-admin db backup --output-dir <dir> --keep <n>` on a calendar
 * schedule. systemd gets a `.service` plus a `.timer`; launchd gets one plist
 * with a `StartCalendarInterval`.
 *
 * Windows and Compose are refused: `sc.exe` has no timer concept, and a
 * Compose orchestrator runs in a container whose host scheduler KiCI does not
 * own. Both refusals name the platform-native equivalent.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogDir } from './platform-detect.js';
import type { ServicePlatform } from './types.js';

/** Default retention: keep the last week of daily dumps. */
export const BACKUP_TIMER_DEFAULT_KEEP = 7;

/** Default calendar spec — midnight every day, on both platforms. */
export const BACKUP_TIMER_DEFAULT_SCHEDULE = 'daily';

/** Reverse-DNS label prefix for the launchd plist. */
const LABEL_PREFIX = 'dev.kici';

export interface BackupTimerConfig {
  /** Orchestrator instance name the timer backs up (e.g. `kici-orchestrator`). */
  serviceName: string;
  /** Calendar spec: a systemd `OnCalendar=` value, or `daily` / `HH:MM`. */
  schedule: string;
  /** Directory the timestamped dumps are written to. */
  outputDir: string;
  /** How many dumps to retain after each run. */
  keep: number;
  /** Node binary the scheduled unit runs. */
  nodeBinPath: string;
  /** `kici-admin` entry script the scheduled unit runs. */
  cliScriptPath: string;
  /** Env file carrying `KICI_DATABASE_URL` for the scheduled run. */
  envFilePath: string;
  /** User-level (`systemctl --user`, LaunchAgent) vs system-level. */
  isUserLevel: boolean;
  /** Account a system-level unit runs as. */
  user?: string;
}

/**
 * `kici-orchestrator` -> `kici-orchestrator-db-backup`. A name that already
 * carries the `kici-` prefix keeps exactly one, so the unit is always
 * `kici-<instance>-db-backup`.
 */
export function backupTimerName(serviceName: string): string {
  const instance = serviceName.replace(/^kici-/, '');
  return `kici-${instance}-db-backup`;
}

/** The argv the scheduled unit executes, after the node binary. */
export function backupCommandArgs(config: BackupTimerConfig): string[] {
  return [
    config.cliScriptPath,
    'db',
    'backup',
    '--output-dir',
    config.outputDir,
    '--keep',
    String(config.keep),
  ];
}

/**
 * Explain why a platform cannot carry a KiCI-managed backup timer, and what to
 * use instead. Returns null when the platform is supported.
 */
export function unsupportedPlatformMessage(
  platform: ServicePlatform,
  outputDir: string,
  keep: number,
): string | null {
  const command = `kici-admin db backup --output-dir ${outputDir} --keep ${keep}`;
  if (platform === 'windows') {
    return (
      'Windows services carry no timer concept, so KiCI installs no backup timer there. ' +
      'Use Windows Task Scheduler instead:\n' +
      `  schtasks /Create /SC DAILY /TN kici-db-backup /TR "${command}"`
    );
  }
  if (platform === 'compose') {
    return (
      'A Compose-deployed orchestrator runs in a container whose host scheduler KiCI does ' +
      'not own, so KiCI installs no backup timer there. Add a host cron entry instead:\n' +
      `  0 0 * * * ${command}`
    );
  }
  return null;
}

/** Throw the {@link unsupportedPlatformMessage} refusal, if there is one. */
export function assertTimerPlatformSupported(
  platform: ServicePlatform,
  outputDir: string,
  keep: number,
): void {
  const message = unsupportedPlatformMessage(platform, outputDir, keep);
  if (message) throw new Error(message);
}

/** Render the systemd `.service` unit the timer triggers. */
export function renderSystemdBackupService(config: BackupTimerConfig): string {
  const name = backupTimerName(config.serviceName);
  const exec = [config.nodeBinPath, ...backupCommandArgs(config)].join(' ');
  const lines = [
    '[Unit]',
    `Description=KiCI orchestrator database backup (${config.serviceName})`,
    `X-KiCI-BackupFor=${config.serviceName}`,
    'After=network.target postgresql.service',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${exec}`,
    `EnvironmentFile=${config.envFilePath}`,
    `Environment=PATH=${path.dirname(config.nodeBinPath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    `WorkingDirectory=${config.outputDir}`,
  ];
  if (!config.isUserLevel && config.user) {
    lines.push(`User=${config.user}`, `Group=${config.user}`);
  }
  lines.push('', '[Install]', `WantedBy=${name}.timer`, '');
  return lines.join('\n');
}

/** Render the systemd `.timer` unit that schedules the backup service. */
export function renderSystemdBackupTimer(config: BackupTimerConfig): string {
  const name = backupTimerName(config.serviceName);
  return (
    [
      '[Unit]',
      `Description=Scheduled KiCI orchestrator database backup (${config.serviceName})`,
      '',
      '[Timer]',
      `OnCalendar=${config.schedule}`,
      'Persistent=true',
      `Unit=${name}.service`,
      '',
      '[Install]',
      'WantedBy=timers.target',
    ].join('\n') + '\n'
  );
}

/**
 * Translate a calendar spec into the launchd `StartCalendarInterval` fields.
 * launchd has no calendar-expression parser, so only the two forms that map
 * cleanly are accepted; anything else is refused by name.
 */
export function parseLaunchdSchedule(schedule: string): { hour: number; minute: number } {
  if (schedule === 'daily' || schedule === 'midnight') return { hour: 0, minute: 0 };
  const match = schedule.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    throw new Error(
      `launchd cannot schedule "${schedule}". Pass --schedule as "daily" or "HH:MM" ` +
        '(24-hour) on macOS; full systemd OnCalendar expressions are Linux-only.',
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read one key out of a `KEY=value` env file. Returns undefined when the file
 * or the key is absent — the caller decides whether that is fatal.
 *
 * The value is trimmed and stripped of surrounding quotes, because these files
 * are hand-edited as often as they are generated: a path written as
 * `"/etc/kici/scalers.yaml"` or left with a trailing space names the same file
 * and must read back the same way. Only the outer quote characters go — an
 * embedded `=` stays, so `B=two=three` still reads as `two=three`.
 *
 * A duplicated key takes its **last** occurrence, because that is the value the
 * running process holds: systemd's `EnvironmentFile=` applies each assignment in
 * order, so the last one wins. Reporting an earlier one would name a path or a
 * database the service never used, which is the opposite of what these readers
 * are for. Every other env-file reader in the repo takes the last occurrence too.
 */
export function readEnvValue(content: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0 && trimmed.slice(0, idx) === key) {
      value = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return value;
}

/**
 * launchd starts a job with a minimal `PATH` that omits Homebrew and the
 * Postgres.app bin directory, so a scheduled dump would not find `pg_dump` at
 * all. The systemd unit above sets `Environment=PATH=…` for the same reason,
 * and the service plist renderer prepends the node bin dir the same way.
 */
const LAUNCHD_DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** Render the launchd plist that schedules the backup run. */
export function renderLaunchdBackupPlist(
  config: BackupTimerConfig,
  env: Record<string, string>,
): string {
  const name = backupTimerName(config.serviceName);
  const { hour, minute } = parseLaunchdSchedule(config.schedule);
  const logDirectory = getLogDir(config.serviceName, config.isUserLevel);
  const pathEnv = { PATH: `${path.dirname(config.nodeBinPath)}:${LAUNCHD_DEFAULT_PATH}` };

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  lines.push('<plist version="1.0">');
  lines.push('<dict>');
  lines.push('  <key>Label</key>');
  lines.push(`  <string>${LABEL_PREFIX}.${name}</string>`);
  lines.push('  <key>KiCIBackupFor</key>');
  lines.push(`  <string>${escapeXml(config.serviceName)}</string>`);
  lines.push('  <key>ProgramArguments</key>');
  lines.push('  <array>');
  for (const arg of [config.nodeBinPath, ...backupCommandArgs(config)]) {
    lines.push(`    <string>${escapeXml(arg)}</string>`);
  }
  lines.push('  </array>');
  lines.push('  <key>WorkingDirectory</key>');
  lines.push(`  <string>${escapeXml(config.outputDir)}</string>`);
  lines.push('  <key>RunAtLoad</key>');
  lines.push('  <false/>');
  lines.push('  <key>StartCalendarInterval</key>');
  lines.push('  <dict>');
  lines.push('    <key>Hour</key>');
  lines.push(`    <integer>${hour}</integer>`);
  lines.push('    <key>Minute</key>');
  lines.push(`    <integer>${minute}</integer>`);
  lines.push('  </dict>');
  lines.push('  <key>StandardOutPath</key>');
  lines.push(`  <string>${escapeXml(path.join(logDirectory, `${name}.out.log`))}</string>`);
  lines.push('  <key>StandardErrorPath</key>');
  lines.push(`  <string>${escapeXml(path.join(logDirectory, `${name}.err.log`))}</string>`);
  if (!config.isUserLevel && config.user) {
    lines.push('  <key>UserName</key>');
    lines.push(`  <string>${escapeXml(config.user)}</string>`);
  }
  lines.push('  <key>EnvironmentVariables</key>');
  lines.push('  <dict>');
  for (const [key, value] of Object.entries({ ...env, ...pathEnv })) {
    lines.push(`    <key>${escapeXml(key)}</key>`);
    lines.push(`    <string>${escapeXml(value)}</string>`);
  }
  lines.push('  </dict>');
  lines.push('</dict>');
  lines.push('</plist>');
  lines.push('');
  return lines.join('\n');
}

/** Filesystem + process seams, so install/uninstall are unit-testable. */
export interface TimerIo {
  mkdirp: (dir: string) => void;
  writeFile: (file: string, content: string) => void;
  readFile: (file: string) => string;
  removeFile: (file: string) => void;
  run: (bin: string, args: string[]) => void;
}

export const defaultTimerIo: TimerIo = {
  mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true }),
  writeFile: (file, content) => fs.writeFileSync(file, content, 'utf-8'),
  readFile: (file) => fs.readFileSync(file, 'utf-8'),
  removeFile: (file) => {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone — uninstall is idempotent.
    }
  },
  run: (bin, args) => void execFileSync(bin, args, { stdio: 'inherit' }),
};

/** Directory holding the generated systemd units for this privilege level. */
export function systemdUnitDir(isUserLevel: boolean): string {
  return isUserLevel
    ? path.join(os.homedir(), '.config', 'systemd', 'user')
    : '/etc/systemd/system';
}

/** Path of the generated launchd plist for this privilege level. */
export function launchdPlistPath(name: string, isUserLevel: boolean): string {
  const filename = `${LABEL_PREFIX}.${name}.plist`;
  return isUserLevel
    ? path.join(os.homedir(), 'Library', 'LaunchAgents', filename)
    : path.join('/Library', 'LaunchDaemons', filename);
}

function systemctlArgs(isUserLevel: boolean, args: string[]): string[] {
  return isUserLevel ? ['--user', ...args] : args;
}

/** Install the backup timer for the detected platform. Returns the files written. */
export function installBackupTimer(
  platform: ServicePlatform,
  config: BackupTimerConfig,
  io: TimerIo = defaultTimerIo,
): { unitName: string; files: string[] } {
  assertTimerPlatformSupported(platform, config.outputDir, config.keep);
  // Reject an unrenderable calendar spec before anything is created on disk.
  if (platform === 'launchd') parseLaunchdSchedule(config.schedule);
  const name = backupTimerName(config.serviceName);
  io.mkdirp(config.outputDir);

  if (platform === 'systemd') {
    const dir = systemdUnitDir(config.isUserLevel);
    io.mkdirp(dir);
    const servicePath = path.join(dir, `${name}.service`);
    const timerPath = path.join(dir, `${name}.timer`);
    io.writeFile(servicePath, renderSystemdBackupService(config));
    io.writeFile(timerPath, renderSystemdBackupTimer(config));
    io.run('systemctl', systemctlArgs(config.isUserLevel, ['daemon-reload']));
    io.run('systemctl', systemctlArgs(config.isUserLevel, ['enable', '--now', `${name}.timer`]));
    return { unitName: name, files: [servicePath, timerPath] };
  }

  // launchd carries no EnvironmentFile directive, so the database URL the
  // scheduled run needs is lifted out of the env file at install time.
  let envContent = '';
  try {
    envContent = io.readFile(config.envFilePath);
  } catch {
    // No env file: the plist still installs, and the run reports the missing
    // URL itself rather than failing here with less context.
  }
  const databaseUrl = readEnvValue(envContent, 'KICI_DATABASE_URL');
  const env: Record<string, string> = databaseUrl ? { KICI_DATABASE_URL: databaseUrl } : {};

  const plistPath = launchdPlistPath(name, config.isUserLevel);
  io.mkdirp(path.dirname(plistPath));
  io.mkdirp(getLogDir(config.serviceName, config.isUserLevel));
  io.writeFile(plistPath, renderLaunchdBackupPlist(config, env));
  const domain = config.isUserLevel ? `gui/${os.userInfo().uid}` : 'system';
  io.run('launchctl', ['bootstrap', domain, plistPath]);
  return { unitName: name, files: [plistPath] };
}

/** Remove the backup timer for the detected platform. Returns the files removed. */
export function uninstallBackupTimer(
  platform: ServicePlatform,
  config: Pick<BackupTimerConfig, 'serviceName' | 'isUserLevel' | 'outputDir' | 'keep'>,
  io: TimerIo = defaultTimerIo,
): { unitName: string; files: string[] } {
  assertTimerPlatformSupported(platform, config.outputDir, config.keep);
  const name = backupTimerName(config.serviceName);

  if (platform === 'systemd') {
    try {
      io.run('systemctl', systemctlArgs(config.isUserLevel, ['disable', '--now', `${name}.timer`]));
    } catch {
      // Not enabled, or already gone — removal continues.
    }
    const dir = systemdUnitDir(config.isUserLevel);
    const files = [path.join(dir, `${name}.service`), path.join(dir, `${name}.timer`)];
    for (const file of files) io.removeFile(file);
    io.run('systemctl', systemctlArgs(config.isUserLevel, ['daemon-reload']));
    return { unitName: name, files };
  }

  const plistPath = launchdPlistPath(name, config.isUserLevel);
  const domain = config.isUserLevel ? `gui/${os.userInfo().uid}` : 'system';
  try {
    io.run('launchctl', ['bootout', `${domain}/${LABEL_PREFIX}.${name}`]);
  } catch {
    // Not loaded — removal continues.
  }
  io.removeFile(plistPath);
  return { unitName: name, files: [plistPath] };
}
