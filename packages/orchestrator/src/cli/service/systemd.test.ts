/**
 * Tests for the systemd service manager.
 *
 * Mocks child_process and fs to verify unit file generation,
 * lifecycle commands, and status parsing without requiring
 * a real systemd installation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceConfig, RestartPolicy } from './types.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({
    stdout: { pipe: vi.fn() },
    stderr: { pipe: vi.fn() },
    on: vi.fn(),
  })),
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
  },
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ''),
}));

// Mock node:os
vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/home/testuser'),
  },
  homedir: vi.fn(() => '/home/testuser'),
}));

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { SystemdServiceManager } from './systemd.js';

const mockedExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockedSpawn = spawn as ReturnType<typeof vi.fn>;
const mockedWriteFileSync = fs.writeFileSync as ReturnType<typeof vi.fn>;
const mockedMkdirSync = fs.mkdirSync as ReturnType<typeof vi.fn>;
const mockedExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockedUnlinkSync = fs.unlinkSync as ReturnType<typeof vi.fn>;
const mockedReaddirSync = fs.readdirSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'kici-orchestrator',
    displayName: 'KiCI Orchestrator',
    description: 'KiCI orchestrator service',
    executablePath: '/usr/local/bin/kici-orchestrator',
    envFilePath: '/etc/kici/orchestrator.env',
    workingDirectory: '/var/lib/kici',
    user: 'kici',
    isUserLevel: false,
    restartPolicy: {
      enabled: true,
      delays: [1, 5, 15, 30],
      maxRetries: 5,
      windowSeconds: 300,
    },
    ...overrides,
  };
}

describe('systemd service manager', () => {
  let manager: SystemdServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SystemdServiceManager();
  });

  describe('generateUnitFile', () => {
    it('produces valid systemd unit with all required sections', () => {
      const config = makeConfig();
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('[Unit]');
      expect(unit).toContain('[Service]');
      expect(unit).toContain('[Install]');
    });

    it('includes description and dependencies', () => {
      const config = makeConfig();
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('Description=KiCI orchestrator service');
      expect(unit).toContain('After=network.target postgresql.service');
    });

    it('includes service execution settings', () => {
      const config = makeConfig();
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('Type=simple');
      expect(unit).toContain('ExecStart=/usr/local/bin/kici-orchestrator');
      expect(unit).toContain('EnvironmentFile=/etc/kici/orchestrator.env');
      expect(unit).toContain('WorkingDirectory=/var/lib/kici');
    });

    it('appends args to ExecStart', () => {
      const config = makeConfig({
        executablePath: '/usr/bin/node',
        args: ['/opt/kici/dist/server.js'],
      });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('ExecStart=/usr/bin/node /opt/kici/dist/server.js');
    });

    it('writes ExecStart without a trailing space when there are no args', () => {
      const config = makeConfig({ executablePath: '/usr/bin/node', args: [] });
      const unit = manager.generateUnitFile(config);

      expect(unit).toMatch(/ExecStart=\/usr\/bin\/node\n/);
    });

    it('sets Environment=PATH with the executable bin dir first so spawned agents find node', () => {
      // The bare-metal scaler spawns `kici-agent` (a `#!/usr/bin/env node`
      // script) as a child of the orchestrator. systemd starts the
      // orchestrator with a minimal default PATH that omits non-standard
      // node installs (mise/nvm/asdf). Prepending the executable's own bin
      // dir guarantees `env node` resolves in the spawned agent.
      const config = makeConfig({
        executablePath: '/home/op/.local/share/mise/installs/node/24/bin/node',
        args: ['/opt/kici/dist/server.js'],
      });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain(
        'Environment=PATH=/home/op/.local/share/mise/installs/node/24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      );
    });

    it('uses nodeBinDir for PATH over the executable dir when set (--binary wrapper case)', () => {
      // executablePath is a wrapper script; nodeBinDir is the real node dir.
      const config = makeConfig({
        executablePath: '/home/op/kici/service/kici-orchestrator',
        nodeBinDir: '/home/op/.cache/kici/node-binaries/v24.15.0/bin',
      });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain(
        'Environment=PATH=/home/op/.cache/kici/node-binaries/v24.15.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      );
      expect(unit).not.toContain('Environment=PATH=/home/op/kici/service:');
    });

    it('includes restart policy settings', () => {
      const config = makeConfig();
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('Restart=on-failure');
      expect(unit).toContain('RestartSec=1s');
      expect(unit).toContain('StartLimitBurst=5');
      expect(unit).toContain('StartLimitIntervalSec=300');
    });

    it('includes security hardening directives', () => {
      const config = makeConfig();
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('NoNewPrivileges=true');
      expect(unit).toContain('ProtectSystem=strict');
      expect(unit).toContain('ProtectHome=read-only');
      expect(unit).toContain('LimitNOFILE=65536');
    });

    it('includes User/Group for system-level services', () => {
      const config = makeConfig({ isUserLevel: false, user: 'kici' });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('User=kici');
      expect(unit).toContain('Group=kici');
    });

    it('omits User/Group for user-level services', () => {
      const config = makeConfig({ isUserLevel: true, user: undefined });
      const unit = manager.generateUnitFile(config);

      expect(unit).not.toContain('User=');
      expect(unit).not.toContain('Group=');
    });

    it('uses multi-user.target for system services', () => {
      const config = makeConfig({ isUserLevel: false });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('WantedBy=multi-user.target');
    });

    it('uses default.target for user services', () => {
      const config = makeConfig({ isUserLevel: true });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('WantedBy=default.target');
    });

    it('includes ReadWritePaths for working directory', () => {
      const config = makeConfig({ workingDirectory: '/var/lib/kici' });
      const unit = manager.generateUnitFile(config);

      expect(unit).toContain('ReadWritePaths=/var/lib/kici');
    });

    it('omits security hardening for user-level services', () => {
      const config = makeConfig({ isUserLevel: true });
      const unit = manager.generateUnitFile(config);

      // User-level services can't set these (no privileges)
      expect(unit).not.toContain('ProtectSystem=');
      expect(unit).not.toContain('ProtectHome=');
      expect(unit).not.toContain('NoNewPrivileges=');
    });
  });

  describe('install', () => {
    it('writes unit file to system path for system services', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.install(config);

      expect(mockedMkdirSync).toHaveBeenCalled();
      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/etc/systemd/system/kici-orchestrator.service',
        expect.any(String),
        'utf-8',
      );
    });

    it('writes unit file to user path for user services', async () => {
      const config = makeConfig({ isUserLevel: true });
      await manager.install(config);

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/home/testuser/.config/systemd/user/kici-orchestrator.service',
        expect.any(String),
        'utf-8',
      );
    });

    it('runs daemon-reload and enable for system services', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['daemon-reload'],
        expect.any(Object),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['enable', 'kici-orchestrator'],
        expect.any(Object),
      );
    });

    it('runs --user daemon-reload and enable for user services', async () => {
      const config = makeConfig({ isUserLevel: true });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['--user', 'daemon-reload'],
        expect.any(Object),
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['--user', 'enable', 'kici-orchestrator'],
        expect.any(Object),
      );
    });

    it('runs loginctl enable-linger for user-level services when linger is disabled', async () => {
      // Make `loginctl show-user --property=Linger` return "Linger=no" so the
      // install path takes the enable-linger branch.
      mockedExecFileSync.mockImplementation((cmd: string, args: readonly string[]) => {
        if (cmd === 'loginctl' && args[0] === 'show-user') {
          return 'Linger=no\n';
        }
        return '';
      });

      const config = makeConfig({ isUserLevel: true, user: 'testuser' });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'loginctl',
        ['enable-linger', 'testuser'],
        expect.any(Object),
      );
    });

    it('skips loginctl enable-linger when linger is already enabled (idempotent)', async () => {
      // Simulate `loginctl show-user --property=Linger` returning "Linger=yes".
      mockedExecFileSync.mockImplementation((cmd: string, args: readonly string[]) => {
        if (cmd === 'loginctl' && args[0] === 'show-user') {
          return 'Linger=yes\n';
        }
        return '';
      });

      const config = makeConfig({ isUserLevel: true, user: 'testuser' });
      await manager.install(config);

      // show-user was called, but enable-linger must NOT have been.
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'loginctl',
        ['show-user', 'testuser', '--property=Linger'],
        expect.any(Object),
      );
      expect(mockedExecFileSync).not.toHaveBeenCalledWith(
        'loginctl',
        ['enable-linger', 'testuser'],
        expect.any(Object),
      );
    });

    it('throws a helpful error when enable-linger fails and linger is not yet enabled', async () => {
      // show-user returns Linger=no so we take the enable-linger branch, and
      // enable-linger itself throws (simulating polkit "Access denied").
      mockedExecFileSync.mockImplementation((cmd: string, args: readonly string[]) => {
        if (cmd === 'loginctl' && args[0] === 'show-user') {
          return 'Linger=no\n';
        }
        if (cmd === 'loginctl' && args[0] === 'enable-linger') {
          throw new Error('Could not enable linger: Access denied');
        }
        return '';
      });

      const config = makeConfig({ isUserLevel: true, user: 'testuser' });
      await expect(manager.install(config)).rejects.toThrow(
        /Failed to enable linger for user "testuser".*sudo loginctl enable-linger testuser/s,
      );
    });
  });

  describe('start', () => {
    it('runs systemctl start for system services', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.start(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['start', 'kici-orchestrator'],
        expect.any(Object),
      );
    });

    it('runs systemctl --user start for user services', async () => {
      const config = makeConfig({ isUserLevel: true });
      await manager.start(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['--user', 'start', 'kici-orchestrator'],
        expect.any(Object),
      );
    });
  });

  describe('stop', () => {
    it('runs systemctl stop', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.stop(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['stop', 'kici-orchestrator'],
        expect.any(Object),
      );
    });
  });

  describe('restart', () => {
    it('runs systemctl restart', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.restart(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'systemctl',
        ['restart', 'kici-orchestrator'],
        expect.any(Object),
      );
    });
  });

  describe('status', () => {
    it('parses running state from systemctl show', async () => {
      mockedExecFileSync.mockReturnValue(
        'ActiveState=active\nMainPID=12345\nExecMainStartTimestamp=Fri 2026-03-14 10:30:00 UTC\n',
      );

      const config = makeConfig({ isUserLevel: false });
      const result = await manager.status(config);

      expect(result.state).toBe('running');
      expect(result.pid).toBe(12345);
      expect(result.startedAt).toBeDefined();
    });

    it('parses stopped state', async () => {
      mockedExecFileSync.mockReturnValue(
        'ActiveState=inactive\nMainPID=0\nExecMainStartTimestamp=\n',
      );

      const config = makeConfig({ isUserLevel: false });
      const result = await manager.status(config);

      expect(result.state).toBe('stopped');
      expect(result.pid).toBeUndefined();
    });

    it('parses failed state', async () => {
      mockedExecFileSync.mockReturnValue(
        'ActiveState=failed\nMainPID=0\nExecMainStartTimestamp=Fri 2026-03-14 10:30:00 UTC\n',
      );

      const config = makeConfig({ isUserLevel: false });
      const result = await manager.status(config);

      expect(result.state).toBe('failed');
    });

    it('returns unknown for unexpected states', async () => {
      mockedExecFileSync.mockReturnValue('ActiveState=activating\nMainPID=0\n');

      const config = makeConfig({ isUserLevel: false });
      const result = await manager.status(config);

      expect(result.state).toBe('unknown');
    });
  });

  describe('uninstall', () => {
    it('stops, disables, removes unit file, and daemon-reloads', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.uninstall(config);

      const calls = mockedExecFileSync.mock.calls.map((c: unknown[]) => c[1]);
      expect(calls).toContainEqual(['stop', 'kici-orchestrator']);
      expect(calls).toContainEqual(['disable', 'kici-orchestrator']);
      expect(calls).toContainEqual(['daemon-reload']);

      expect(mockedUnlinkSync).toHaveBeenCalledWith(
        '/etc/systemd/system/kici-orchestrator.service',
      );
    });
  });

  describe('isInstalled', () => {
    it('returns true when unit file exists', async () => {
      mockedExistsSync.mockReturnValue(true);
      const config = makeConfig({ isUserLevel: false });
      expect(await manager.isInstalled(config)).toBe(true);
    });

    it('returns false when unit file does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      const config = makeConfig({ isUserLevel: false });
      expect(await manager.isInstalled(config)).toBe(false);
    });
  });

  describe('logs', () => {
    it('spawns journalctl with correct flags for follow mode', async () => {
      const mockChild = {
        stdout: { pipe: vi.fn() },
        stderr: { pipe: vi.fn() },
        on: vi.fn((_event: string, cb: (code: number) => void) => {
          if (_event === 'close') cb(0);
        }),
      };
      mockedSpawn.mockReturnValue(mockChild);

      const config = makeConfig({ isUserLevel: false });
      await manager.logs(config, { follow: true, since: '1h', level: 'error', json: true });

      expect(mockedSpawn).toHaveBeenCalledWith(
        'journalctl',
        expect.arrayContaining([
          '-u',
          'kici-orchestrator',
          '-f',
          '--since',
          '1h ago',
          '--priority',
          '3',
          '--output',
          'json',
        ]),
        expect.any(Object),
      );
    });

    it('uses --user flag for user-level services', async () => {
      const mockChild = {
        stdout: { pipe: vi.fn() },
        stderr: { pipe: vi.fn() },
        on: vi.fn((_event: string, cb: (code: number) => void) => {
          if (_event === 'close') cb(0);
        }),
      };
      mockedSpawn.mockReturnValue(mockChild);

      const config = makeConfig({ isUserLevel: true });
      await manager.logs(config, {});

      expect(mockedSpawn).toHaveBeenCalledWith(
        'journalctl',
        expect.arrayContaining(['--user-unit', 'kici-orchestrator']),
        expect.any(Object),
      );
    });
  });

  describe('component marker + list()', () => {
    it('writes X-KiCI-Component=orchestrator into the [Unit] section when component is set', async () => {
      const config = makeConfig({ isUserLevel: false, component: 'orchestrator' });
      await manager.install(config);

      const writtenContent = mockedWriteFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === '/etc/systemd/system/kici-orchestrator.service',
      )?.[1] as string | undefined;

      expect(writtenContent).toBeDefined();
      expect(writtenContent).toContain('X-KiCI-Component=orchestrator');

      // Marker must live inside the [Unit] section, not [Service] or [Install].
      const unitSection = writtenContent!.slice(
        writtenContent!.indexOf('[Unit]'),
        writtenContent!.indexOf('[Service]'),
      );
      expect(unitSection).toContain('X-KiCI-Component=orchestrator');
    });

    it('omits the X-KiCI-Component line when component is not set', () => {
      const config = makeConfig({ component: undefined });
      const unit = manager.generateUnitFile(config);

      expect(unit).not.toContain('X-KiCI-Component');
    });

    it('list() returns kici-* units with a valid X-KiCI-Component marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/home/testuser/.config/systemd/user',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user') return ['kici-foo.service'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user/kici-foo.service') {
          return [
            '[Unit]',
            'Description=KiCI agent kici-foo',
            'X-KiCI-Component=agent',
            '',
            '[Service]',
            'Type=simple',
            '',
            '[Install]',
            'WantedBy=default.target',
            '',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result).toContainEqual({
        name: 'kici-foo',
        platform: 'systemd',
        isUserLevel: true,
        component: 'agent',
      });
    });

    it('writes X-KiCI-InstanceDir into the [Unit] section when instanceDir is set', async () => {
      const config = makeConfig({
        isUserLevel: false,
        component: 'orchestrator',
        instanceDir: '/srv/kici-deploy',
      });
      await manager.install(config);

      const writtenContent = mockedWriteFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === '/etc/systemd/system/kici-orchestrator.service',
      )?.[1] as string | undefined;

      expect(writtenContent).toBeDefined();
      const unitSection = writtenContent!.slice(
        writtenContent!.indexOf('[Unit]'),
        writtenContent!.indexOf('[Service]'),
      );
      expect(unitSection).toContain('X-KiCI-InstanceDir=/srv/kici-deploy');
    });

    it('omits the X-KiCI-InstanceDir line when instanceDir is not set', () => {
      const config = makeConfig({ component: 'orchestrator', instanceDir: undefined });
      const unit = manager.generateUnitFile(config);

      expect(unit).not.toContain('X-KiCI-InstanceDir');
    });

    it('list() recovers instanceDir from the X-KiCI-InstanceDir marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/home/testuser/.config/systemd/user',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user') return ['kici-foo.service'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user/kici-foo.service') {
          return [
            '[Unit]',
            'Description=KiCI orchestrator kici-foo',
            'X-KiCI-Component=orchestrator',
            'X-KiCI-InstanceDir=/home/testuser/kici-foo',
            '',
            '[Service]',
            'Type=simple',
            '',
            '[Install]',
            'WantedBy=default.target',
            '',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result).toContainEqual({
        name: 'kici-foo',
        platform: 'systemd',
        isUserLevel: true,
        component: 'orchestrator',
        instanceDir: '/home/testuser/kici-foo',
      });
    });

    it('list() leaves instanceDir undefined for a unit without the marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/home/testuser/.config/systemd/user',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user') return ['kici-old.service'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user/kici-old.service') {
          return ['[Unit]', 'X-KiCI-Component=orchestrator', '', '[Service]', ''].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result.find((r) => r.name === 'kici-old')?.instanceDir).toBeUndefined();
    });

    it('list() skips kici-* units that do not carry an X-KiCI-Component marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/home/testuser/.config/systemd/user',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user') return ['kici-bare.service'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/home/testuser/.config/systemd/user/kici-bare.service') {
          return [
            '[Unit]',
            'Description=Some unrelated kici-prefixed service',
            '',
            '[Service]',
            'Type=simple',
            '',
            '[Install]',
            'WantedBy=default.target',
            '',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result.find((r) => r.name === 'kici-bare')).toBeUndefined();
    });
  });

  describe('readLaunchSpec', () => {
    const config = makeConfig({ isUserLevel: true });

    it('parses node + entry script from the ExecStart line', async () => {
      mockedReadFileSync.mockReturnValueOnce(
        [
          '[Service]',
          'Type=simple',
          'ExecStart=/n/24.15.0/bin/node /n/24.15.0/lib/node_modules/kici-admin/node_modules/@kici-dev/orchestrator/dist/server.js',
          'EnvironmentFile=/x/kici.env',
        ].join('\n'),
      );
      const spec = await manager.readLaunchSpec(config);
      expect(spec).toEqual({
        execPath: '/n/24.15.0/bin/node',
        args: [
          '/n/24.15.0/lib/node_modules/kici-admin/node_modules/@kici-dev/orchestrator/dist/server.js',
        ],
      });
    });

    it('returns null when there is no ExecStart line', async () => {
      mockedReadFileSync.mockReturnValueOnce('[Service]\nType=simple\n');
      expect(await manager.readLaunchSpec(config)).toBeNull();
    });

    it('returns null when the unit file cannot be read', async () => {
      mockedReadFileSync.mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });
      expect(await manager.readLaunchSpec(config)).toBeNull();
    });
  });
});
