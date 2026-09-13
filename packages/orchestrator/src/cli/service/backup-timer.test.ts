/**
 * Tests for the scheduled database-backup timer.
 *
 * Rendering is asserted against the generated unit / plist text; install and
 * uninstall run against an in-memory {@link TimerIo} so no unit file is written
 * and no `systemctl` / `launchctl` process is spawned.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/home/testuser'),
    platform: vi.fn(() => 'linux'),
    userInfo: vi.fn(() => ({ uid: 501 })),
  },
  homedir: vi.fn(() => '/home/testuser'),
  platform: vi.fn(() => 'linux'),
  userInfo: vi.fn(() => ({ uid: 501 })),
}));

import {
  BACKUP_TIMER_DEFAULT_KEEP,
  backupCommandArgs,
  backupTimerName,
  installBackupTimer,
  launchdPlistPath,
  parseLaunchdSchedule,
  readEnvValue,
  renderLaunchdBackupPlist,
  renderSystemdBackupService,
  renderSystemdBackupTimer,
  systemdUnitDir,
  uninstallBackupTimer,
  unsupportedPlatformMessage,
  type BackupTimerConfig,
  type TimerIo,
} from './backup-timer.js';

function makeConfig(overrides: Partial<BackupTimerConfig> = {}): BackupTimerConfig {
  return {
    serviceName: 'kici-orchestrator',
    schedule: 'daily',
    outputDir: '/var/lib/kici/backups',
    keep: BACKUP_TIMER_DEFAULT_KEEP,
    nodeBinPath: '/usr/bin/node',
    cliScriptPath: '/opt/kici/bin/kici-admin.js',
    envFilePath: '/etc/kici/kici-orchestrator/orchestrator.env',
    isUserLevel: true,
    ...overrides,
  };
}

function makeIo(files: Record<string, string> = {}): TimerIo & {
  written: Map<string, string>;
  removed: string[];
  commands: Array<[string, string[]]>;
} {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const commands: Array<[string, string[]]> = [];
  return {
    written,
    removed,
    commands,
    mkdirp: () => undefined,
    writeFile: (file, content) => void written.set(file, content),
    readFile: (file) => {
      const content = files[file];
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    },
    removeFile: (file) => void removed.push(file),
    run: (bin, args) => void commands.push([bin, args]),
  };
}

describe('backupTimerName', () => {
  it('renders one kici- prefix whether or not the instance carries it', () => {
    expect(backupTimerName('kici-orchestrator')).toBe('kici-orchestrator-db-backup');
    expect(backupTimerName('prod')).toBe('kici-prod-db-backup');
  });
});

describe('backupCommandArgs', () => {
  it('runs db backup against the retention directory', () => {
    expect(backupCommandArgs(makeConfig({ keep: 3 }))).toEqual([
      '/opt/kici/bin/kici-admin.js',
      'db',
      'backup',
      '--output-dir',
      '/var/lib/kici/backups',
      '--keep',
      '3',
    ]);
  });
});

describe('renderSystemdBackupService', () => {
  it('renders a oneshot unit that runs the CLI with the env file', () => {
    const unit = renderSystemdBackupService(makeConfig());
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('X-KiCI-BackupFor=kici-orchestrator');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /opt/kici/bin/kici-admin.js db backup --output-dir /var/lib/kici/backups --keep 7',
    );
    expect(unit).toContain('EnvironmentFile=/etc/kici/kici-orchestrator/orchestrator.env');
    expect(unit).toContain('WorkingDirectory=/var/lib/kici/backups');
    expect(unit).toContain('WantedBy=kici-orchestrator-db-backup.timer');
  });

  it('sets User/Group only for a system-level unit', () => {
    expect(renderSystemdBackupService(makeConfig({ user: 'kici' }))).not.toContain('User=kici');
    const system = renderSystemdBackupService(makeConfig({ isUserLevel: false, user: 'kici' }));
    expect(system).toContain('User=kici');
    expect(system).toContain('Group=kici');
  });
});

describe('renderSystemdBackupTimer', () => {
  it('schedules the service daily and catches up after downtime', () => {
    const timer = renderSystemdBackupTimer(makeConfig());
    expect(timer).toContain('[Timer]');
    expect(timer).toContain('OnCalendar=daily');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=kici-orchestrator-db-backup.service');
    expect(timer).toContain('WantedBy=timers.target');
  });

  it('passes an explicit calendar spec straight through', () => {
    expect(renderSystemdBackupTimer(makeConfig({ schedule: '*-*-* 02:30:00' }))).toContain(
      'OnCalendar=*-*-* 02:30:00',
    );
  });
});

describe('parseLaunchdSchedule', () => {
  it('maps daily to midnight and accepts HH:MM', () => {
    expect(parseLaunchdSchedule('daily')).toEqual({ hour: 0, minute: 0 });
    expect(parseLaunchdSchedule('02:30')).toEqual({ hour: 2, minute: 30 });
    expect(parseLaunchdSchedule('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('refuses a systemd calendar expression by name', () => {
    expect(() => parseLaunchdSchedule('*-*-* 02:30:00')).toThrow(/daily. or .HH:MM/);
    expect(() => parseLaunchdSchedule('24:00')).toThrow(/launchd cannot schedule/);
  });
});

describe('renderLaunchdBackupPlist', () => {
  it('renders a StartCalendarInterval plist carrying the run command', () => {
    const plist = renderLaunchdBackupPlist(makeConfig({ schedule: '02:30' }), {
      KICI_DATABASE_URL: 'postgres://kici@localhost/kici',
    });
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain('<string>dev.kici.kici-orchestrator-db-backup</string>');
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<key>Hour</key>');
    expect(plist).toContain('<integer>2</integer>');
    expect(plist).toContain('<key>Minute</key>');
    expect(plist).toContain('<integer>30</integer>');
    expect(plist).toContain('<string>/opt/kici/bin/kici-admin.js</string>');
    expect(plist).toContain('<string>--output-dir</string>');
    expect(plist).toContain('<key>KICI_DATABASE_URL</key>');
    expect(plist).toContain('<string>postgres://kici@localhost/kici</string>');
    // A calendar job must not also fire the moment it is loaded.
    expect(plist).toContain('<key>RunAtLoad</key>\n  <false/>');
    expect(plist).toContain('</plist>');
  });

  it('escapes XML metacharacters in the rendered paths', () => {
    const plist = renderLaunchdBackupPlist(makeConfig({ outputDir: '/var/a&b' }), {});
    expect(plist).toContain('<string>/var/a&amp;b</string>');
  });

  it('carries a PATH that can find pg_dump, whatever the env file held', () => {
    // launchd starts a job with a minimal PATH, so without this the scheduled
    // dump cannot find pg_dump on a Homebrew or Postgres.app install.
    const plist = renderLaunchdBackupPlist(makeConfig({ nodeBinPath: '/opt/node/bin/node' }), {});
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain(
      '<string>/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    );
  });
});

describe('unsupportedPlatformMessage', () => {
  it('names Task Scheduler on Windows and cron on Compose', () => {
    const windows = unsupportedPlatformMessage('windows', '/backups', 7);
    expect(windows).toContain('Windows Task Scheduler');
    expect(windows).toContain('schtasks /Create');
    expect(windows).toContain('kici-admin db backup --output-dir /backups --keep 7');

    const compose = unsupportedPlatformMessage('compose', '/backups', 7);
    expect(compose).toContain('host cron');
    expect(compose).toContain('kici-admin db backup --output-dir /backups --keep 7');
  });

  it('returns null for the two supported platforms', () => {
    expect(unsupportedPlatformMessage('systemd', '/backups', 7)).toBeNull();
    expect(unsupportedPlatformMessage('launchd', '/backups', 7)).toBeNull();
  });
});

describe('installBackupTimer', () => {
  it('writes both systemd units and enables the timer', () => {
    const io = makeIo();
    const result = installBackupTimer('systemd', makeConfig(), io);

    expect(result.unitName).toBe('kici-orchestrator-db-backup');
    const dir = systemdUnitDir(true);
    expect(result.files).toEqual([
      `${dir}/kici-orchestrator-db-backup.service`,
      `${dir}/kici-orchestrator-db-backup.timer`,
    ]);
    expect(io.written.get(result.files[1])).toContain('OnCalendar=daily');
    expect(io.commands).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'kici-orchestrator-db-backup.timer']],
    ]);
  });

  it('drops --user for a system-level timer', () => {
    const io = makeIo();
    installBackupTimer('systemd', makeConfig({ isUserLevel: false, user: 'kici' }), io);
    expect(io.commands[0]).toEqual(['systemctl', ['daemon-reload']]);
  });

  it('lifts the database URL out of the env file into the launchd plist', () => {
    const envPath = '/etc/kici/kici-orchestrator/orchestrator.env';
    const io = makeIo({
      [envPath]: '# comment\nKICI_SECRET_KEY=nope\nKICI_DATABASE_URL=postgres://x@h/db\n',
    });
    const result = installBackupTimer('launchd', makeConfig(), io);

    expect(result.files).toEqual([launchdPlistPath('kici-orchestrator-db-backup', true)]);
    const plist = io.written.get(result.files[0])!;
    expect(plist).toContain('<string>postgres://x@h/db</string>');
    expect(plist).not.toContain('KICI_SECRET_KEY');
    expect(io.commands[0][0]).toBe('launchctl');
    expect(io.commands[0][1][0]).toBe('bootstrap');
  });

  it('refuses on windows and compose, naming the manual equivalent', () => {
    const io = makeIo();
    expect(() => installBackupTimer('windows', makeConfig(), io)).toThrow(/Windows Task Scheduler/);
    expect(() => installBackupTimer('compose', makeConfig(), io)).toThrow(/host cron/);
    expect(io.written.size).toBe(0);
    expect(io.commands).toEqual([]);
  });
});

describe('uninstallBackupTimer', () => {
  it('disables the timer and removes both systemd units', () => {
    const io = makeIo();
    const result = uninstallBackupTimer(
      'systemd',
      { serviceName: 'kici-orchestrator', isUserLevel: true, outputDir: '/b', keep: 7 },
      io,
    );

    const dir = systemdUnitDir(true);
    expect(result.files).toEqual([
      `${dir}/kici-orchestrator-db-backup.service`,
      `${dir}/kici-orchestrator-db-backup.timer`,
    ]);
    expect(io.removed).toEqual(result.files);
    expect(io.commands).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'kici-orchestrator-db-backup.timer']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('boots out and removes the launchd plist', () => {
    const io = makeIo();
    const result = uninstallBackupTimer(
      'launchd',
      { serviceName: 'kici-orchestrator', isUserLevel: true, outputDir: '/b', keep: 7 },
      io,
    );
    expect(io.commands[0]).toEqual([
      'launchctl',
      ['bootout', 'gui/501/dev.kici.kici-orchestrator-db-backup'],
    ]);
    expect(io.removed).toEqual(result.files);
  });

  it('refuses on windows and compose', () => {
    const io = makeIo();
    const target = {
      serviceName: 'kici-orchestrator',
      isUserLevel: true,
      outputDir: '/b',
      keep: 7,
    };
    expect(() => uninstallBackupTimer('windows', target, io)).toThrow(/Windows Task Scheduler/);
    expect(() => uninstallBackupTimer('compose', target, io)).toThrow(/host cron/);
    expect(io.removed).toEqual([]);
  });
});

describe('readEnvValue', () => {
  it('reads a key, skipping comments and blanks', () => {
    const content = '\n# note\nA=1\nB=two=three\n';
    expect(readEnvValue(content, 'A')).toBe('1');
    expect(readEnvValue(content, 'B')).toBe('two=three');
    expect(readEnvValue(content, 'C')).toBeUndefined();
  });

  it('strips surrounding quotes and padding around the value', () => {
    // fails-when: the unquote is dropped — the value keeps its quotes.
    expect(
      readEnvValue('KICI_SCALER_CONFIG_PATH="/etc/kici/s.yaml"\n', 'KICI_SCALER_CONFIG_PATH'),
    ).toBe('/etc/kici/s.yaml');
    // fails-when: the value trim is dropped — returns ' /etc/kici/s.yaml'. The
    // space sits AFTER the `=`, so it survives the per-line trim that runs
    // before the split; a space at end of line would pin nothing.
    expect(
      readEnvValue('KICI_SCALER_CONFIG_PATH= /etc/kici/s.yaml\n', 'KICI_SCALER_CONFIG_PATH'),
    ).toBe('/etc/kici/s.yaml');
  });

  it('takes the last occurrence of a duplicated key, as systemd does', () => {
    // fails-when: the loop returns on its first match — this reads back
    // '/etc/kici/old.yaml' while the running service holds '/etc/kici/new.yaml'.
    expect(
      readEnvValue(
        'KICI_SCALER_CONFIG_PATH=/etc/kici/old.yaml\nKICI_SCALER_CONFIG_PATH=/etc/kici/new.yaml\n',
        'KICI_SCALER_CONFIG_PATH',
      ),
    ).toBe('/etc/kici/new.yaml');
    // The last occurrence wins even when an earlier one is the only usable
    // value: systemd hands the process the last assignment either way.
    expect(readEnvValue('KICI_PORT=4100\nKICI_PORT=not-a-port\n', 'KICI_PORT')).toBe('not-a-port');
  });

  it('breaks-if-wrong: a single occurrence still resolves, quotes and all', () => {
    // The last-occurrence scan must not change the ordinary case, which is
    // every real env file: one line per key.
    expect(readEnvValue('KICI_DATABASE_URL=postgres://one\n', 'KICI_DATABASE_URL')).toBe(
      'postgres://one',
    );
    expect(readEnvValue('A=1\nB="two"\n# C=3\n', 'B')).toBe('two');
    expect(readEnvValue('A=1\nB=2\n', 'C')).toBeUndefined();
  });
});
