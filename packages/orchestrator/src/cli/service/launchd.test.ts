/**
 * Tests for the launchd service manager.
 *
 * Mocks child_process and fs to verify plist generation,
 * lifecycle commands, and status parsing without requiring
 * a real macOS environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceConfig } from './types.js';

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
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
  },
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
}));

// Mock node:os
vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/Users/testuser'),
    userInfo: vi.fn(() => ({ uid: 501 })),
  },
  homedir: vi.fn(() => '/Users/testuser'),
  userInfo: vi.fn(() => ({ uid: 501 })),
}));

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { LaunchdServiceManager } from './launchd.js';

const mockedExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockedSpawn = spawn as ReturnType<typeof vi.fn>;
const mockedWriteFileSync = fs.writeFileSync as ReturnType<typeof vi.fn>;
const mockedMkdirSync = fs.mkdirSync as ReturnType<typeof vi.fn>;
const mockedExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockedUnlinkSync = fs.unlinkSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;
const mockedReaddirSync = fs.readdirSync as ReturnType<typeof vi.fn>;

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

describe('launchd service manager', () => {
  let manager: LaunchdServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new LaunchdServiceManager();
  });

  describe('generatePlist', () => {
    it('produces valid XML plist', () => {
      const config = makeConfig();
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plist).toContain('<!DOCTYPE plist');
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('</plist>');
    });

    it('includes label with dev.kici prefix', () => {
      const config = makeConfig({ name: 'kici-orchestrator' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>Label</key>');
      expect(plist).toContain('<string>dev.kici.kici-orchestrator</string>');
    });

    it('includes ProgramArguments with executable path', () => {
      const config = makeConfig({ executablePath: '/usr/local/bin/kici-orchestrator' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>ProgramArguments</key>');
      expect(plist).toContain('<string>/usr/local/bin/kici-orchestrator</string>');
    });

    it('includes args as additional ProgramArguments entries', () => {
      const config = makeConfig({
        executablePath: '/usr/bin/node',
        args: ['/opt/kici/dist/server.js'],
      });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<string>/usr/bin/node</string>');
      expect(plist).toContain('<string>/opt/kici/dist/server.js</string>');
    });

    it('includes KeepAlive and RunAtLoad', () => {
      const config = makeConfig();
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<true/>');
    });

    it('includes ThrottleInterval from restart policy', () => {
      const config = makeConfig({
        restartPolicy: { enabled: true, delays: [5], maxRetries: 3, windowSeconds: 60 },
      });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>ThrottleInterval</key>');
      expect(plist).toContain('<integer>5</integer>');
    });

    it('includes WorkingDirectory', () => {
      const config = makeConfig({ workingDirectory: '/var/lib/kici' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>WorkingDirectory</key>');
      expect(plist).toContain('<string>/var/lib/kici</string>');
    });

    it('includes StandardOutPath and StandardErrorPath', () => {
      const config = makeConfig({ name: 'kici-orchestrator' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>StandardOutPath</key>');
      expect(plist).toContain('<key>StandardErrorPath</key>');
    });

    it('includes EnvironmentVariables from env file', () => {
      mockedReadFileSync.mockReturnValue('DB_URL=postgres://localhost/kici\nPORT=8080\n');
      const config = makeConfig();
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>EnvironmentVariables</key>');
      expect(plist).toContain('<key>DB_URL</key>');
      expect(plist).toContain('<string>postgres://localhost/kici</string>');
      expect(plist).toContain('<key>PORT</key>');
      expect(plist).toContain('<string>8080</string>');
    });

    it('puts the node bin dir on PATH (EnvironmentVariables.PATH)', () => {
      mockedReadFileSync.mockReturnValue('');
      const config = makeConfig({ executablePath: '/opt/homebrew/Cellar/node/24.0.0/bin/node' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>EnvironmentVariables</key>');
      expect(plist).toContain('<key>PATH</key>');
      // execBinDir is prepended, followed by the macOS default tail.
      expect(plist).toContain(
        '<string>/opt/homebrew/Cellar/node/24.0.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
      );
    });

    it('overrides an env-file PATH with the computed PATH (no duplicate key)', () => {
      mockedReadFileSync.mockReturnValue('PATH=/custom/bin\nFOO=bar\n');
      const config = makeConfig({ executablePath: '/usr/local/bin/node' });
      const plist = manager.generatePlist(config);

      // execBinDir prepended to the env-file PATH, single PATH key.
      expect(plist).toContain('<string>/usr/local/bin:/custom/bin</string>');
      expect((plist.match(/<key>PATH<\/key>/g) ?? []).length).toBe(1);
      // Other env-file vars survive.
      expect(plist).toContain('<key>FOO</key>');
    });

    it('uses nodeBinDir for PATH over the executable dir when set (--binary wrapper case)', () => {
      mockedReadFileSync.mockReturnValue('');
      // executablePath is a wrapper script; nodeBinDir is the real node dir.
      const config = makeConfig({
        executablePath: '/Users/op/kici/service/kici-orchestrator',
        nodeBinDir: '/Users/op/.cache/kici/node-binaries/v24.15.0/bin',
      });
      const plist = manager.generatePlist(config);

      expect(plist).toContain(
        '<string>/Users/op/.cache/kici/node-binaries/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
      );
      // The wrapper dir is NOT used as the PATH prefix.
      expect(plist).not.toContain('<string>/Users/op/kici/service:/opt/homebrew/bin');
    });

    it('skips empty lines and comments in env file', () => {
      mockedReadFileSync.mockReturnValue('# comment\n\nKEY=value\n');
      const config = makeConfig();
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>KEY</key>');
      expect(plist).not.toContain('# comment');
    });

    it('always emits EnvironmentVariables with PATH even when the env file is missing', () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const config = makeConfig({ executablePath: '/usr/local/bin/node' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('<key>EnvironmentVariables</key>');
      expect(plist).toContain('<key>PATH</key>');
      expect(plist).toContain(
        '<string>/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
      );
    });

    it('includes UserName for system-level daemons', () => {
      const config = makeConfig({ isUserLevel: false, user: 'kici' });
      const plist = manager.generatePlist(config);

      expect(plist).toContain('<key>UserName</key>');
      expect(plist).toContain('<string>kici</string>');
    });

    it('omits UserName for user-level agents', () => {
      const config = makeConfig({ isUserLevel: true });
      const plist = manager.generatePlist(config);

      expect(plist).not.toContain('<key>UserName</key>');
    });
  });

  describe('install', () => {
    it('writes plist to system path for system daemons', async () => {
      const config = makeConfig({ isUserLevel: false });
      // No existing instance loaded, so install goes straight to bootstrap.
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') throw new Error('not loaded');
        return '';
      });
      await manager.install(config);

      expect(mockedMkdirSync).toHaveBeenCalled();
      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist',
        expect.any(String),
        'utf-8',
      );
    });

    it('writes plist to user path for user agents', async () => {
      const config = makeConfig({ isUserLevel: true });
      // No existing instance loaded, so install goes straight to bootstrap.
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') throw new Error('not loaded');
        return '';
      });
      await manager.install(config);

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/Users/testuser/Library/LaunchAgents/dev.kici.kici-orchestrator.plist',
        expect.any(String),
        'utf-8',
      );
    });

    it('bootstraps the plist into the system domain for a LaunchDaemon', async () => {
      const config = makeConfig({ isUserLevel: false });
      // Mock isLoaded to return false (no existing instance to boot out).
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw new Error('not loaded');
        }
        return '';
      });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['bootstrap', 'system', '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist'],
        expect.any(Object),
      );
    });

    it('bootstraps the plist into the gui/<uid> domain for a LaunchAgent', async () => {
      const config = makeConfig({ isUserLevel: true });
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw new Error('not loaded');
        }
        return '';
      });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        [
          'bootstrap',
          'gui/501',
          '/Users/testuser/Library/LaunchAgents/dev.kici.kici-orchestrator.plist',
        ],
        expect.any(Object),
      );
    });

    it('boots out an existing instance before bootstrapping (idempotent re-install)', async () => {
      const config = makeConfig({ isUserLevel: false });
      // isLoaded → true until bootout runs, then false (launchd released it),
      // so waitUntilUnloaded clears immediately and bootstrap proceeds.
      let bootedOut = false;
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'bootout') {
          bootedOut = true;
          return '';
        }
        if (Array.isArray(args) && args[0] === 'print') {
          if (bootedOut) throw new Error('not loaded'); // unloaded after bootout
          return ''; // success → isLoaded === true
        }
        return '';
      });
      await manager.install(config);

      const calls = mockedExecFileSync.mock.calls.map((c: unknown[]) => c[1]);
      expect(calls).toContainEqual(['bootout', 'system/dev.kici.kici-orchestrator']);
      expect(calls).toContainEqual([
        'bootstrap',
        'system',
        '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist',
      ]);
    });

    it('retries bootstrap on the transient EIO race after a same-named service unloads', async () => {
      const config = makeConfig({ isUserLevel: false });
      // No existing instance to boot out; the first bootstrap hits the
      // post-teardown EIO race (exit code 5), the retry succeeds.
      let bootstrapCalls = 0;
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw new Error('not loaded'); // isLoaded === false throughout
        }
        if (Array.isArray(args) && args[0] === 'bootstrap') {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) {
            const err = new Error('Bootstrap failed: 5: Input/output error') as Error & {
              status?: number;
              stderr?: string;
            };
            err.status = 5;
            err.stderr = 'Bootstrap failed: 5: Input/output error\n';
            throw err;
          }
          return '';
        }
        return '';
      });

      await manager.install(config);

      expect(bootstrapCalls).toBe(2);
    });

    it('does not retry a non-transient bootstrap failure (bad plist / permission denied)', async () => {
      const config = makeConfig({ isUserLevel: false });
      let bootstrapCalls = 0;
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw new Error('not loaded');
        }
        if (Array.isArray(args) && args[0] === 'bootstrap') {
          bootstrapCalls += 1;
          const err = new Error('Load failed: 22: Invalid argument') as Error & {
            status?: number;
            stderr?: string;
          };
          err.status = 22;
          err.stderr = 'Load failed: 22: Invalid argument\n';
          throw err;
        }
        return '';
      });

      await expect(manager.install(config)).rejects.toThrow(/22: Invalid argument/);
      expect(bootstrapCalls).toBe(1);
    });

    it('chowns the log dir to UserName when installing system-level with a non-root run user', async () => {
      // System-level LaunchDaemon + UserName set → log dir was created by
      // the installing root user, but launchd opens stdout/stderr as the
      // spawned-user identity. Without the chown, the daemon would never
      // spawn (state stays "spawn scheduled", no log output ever).
      const config = makeConfig({ isUserLevel: false, user: 'cmaster11' });
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw new Error('not loaded');
        }
        return '';
      });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'chown',
        ['-R', 'cmaster11:staff', '/var/log/kici'],
        expect.any(Object),
      );
    });

    it('skips the log-dir chown when installing user-level (homedir already owned)', async () => {
      const config = makeConfig({ isUserLevel: true });
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw new Error('not loaded');
        }
        return '';
      });
      await manager.install(config);

      const chownCalls = mockedExecFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'chown');
      expect(chownCalls).toHaveLength(0);
    });
  });

  describe('start', () => {
    it('runs `launchctl kickstart -k <domain>/<label>`', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.start(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['kickstart', '-k', 'system/dev.kici.kici-orchestrator'],
        expect.any(Object),
      );
    });

    it('targets the gui/<uid> domain for user-level services', async () => {
      const config = makeConfig({ isUserLevel: true });
      await manager.start(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['kickstart', '-k', 'gui/501/dev.kici.kici-orchestrator'],
        expect.any(Object),
      );
    });
  });

  describe('stop', () => {
    it('runs `launchctl kill TERM <domain>/<label>`', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.stop(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['kill', 'TERM', 'system/dev.kici.kici-orchestrator'],
        expect.any(Object),
      );
    });
  });

  describe('restart', () => {
    it('stops then starts the service', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.restart(config);

      const calls = mockedExecFileSync.mock.calls.map((c: unknown[]) => c[1]);
      expect(calls).toContainEqual(['kill', 'TERM', 'system/dev.kici.kici-orchestrator']);
      expect(calls).toContainEqual(['kickstart', '-k', 'system/dev.kici.kici-orchestrator']);
    });
  });

  describe('status', () => {
    it('parses running state from launchctl list', async () => {
      mockedExecFileSync.mockReturnValue('12345\t0\tdev.kici.kici-orchestrator\n');

      const config = makeConfig();
      const result = await manager.status(config);

      expect(result.state).toBe('running');
      expect(result.pid).toBe(12345);
    });

    it('parses stopped state when PID is -', async () => {
      mockedExecFileSync.mockReturnValue('-\t0\tdev.kici.kici-orchestrator\n');

      const config = makeConfig();
      const result = await manager.status(config);

      expect(result.state).toBe('stopped');
      expect(result.pid).toBeUndefined();
    });

    it('returns failed state when exit code is non-zero', async () => {
      mockedExecFileSync.mockReturnValue('-\t1\tdev.kici.kici-orchestrator\n');

      const config = makeConfig();
      const result = await manager.status(config);

      expect(result.state).toBe('failed');
    });

    it('returns unknown when service not found in launchctl list', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('Could not find service');
      });

      const config = makeConfig();
      const result = await manager.status(config);

      expect(result.state).toBe('unknown');
    });
  });

  describe('uninstall', () => {
    it('boots out the system-domain target and removes plist', async () => {
      const config = makeConfig({ isUserLevel: false });
      await manager.uninstall(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['bootout', 'system/dev.kici.kici-orchestrator'],
        expect.any(Object),
      );
      expect(mockedUnlinkSync).toHaveBeenCalledWith(
        '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist',
      );
    });

    it('boots out the gui/<uid> domain target for user-level services', async () => {
      const config = makeConfig({ isUserLevel: true });
      await manager.uninstall(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['bootout', 'gui/501/dev.kici.kici-orchestrator'],
        expect.any(Object),
      );
    });
  });

  describe('isInstalled', () => {
    it('returns true when plist file exists', async () => {
      mockedExistsSync.mockReturnValue(true);
      const config = makeConfig({ isUserLevel: false });
      expect(await manager.isInstalled(config)).toBe(true);
    });

    it('returns false when plist file does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      const config = makeConfig({ isUserLevel: false });
      expect(await manager.isInstalled(config)).toBe(false);
    });
  });

  describe('logs', () => {
    it('spawns tail for log files', async () => {
      const mockChild = {
        stdout: { pipe: vi.fn() },
        stderr: { pipe: vi.fn() },
        on: vi.fn((_event: string, cb: (code: number) => void) => {
          if (_event === 'close') cb(0);
        }),
      };
      mockedSpawn.mockReturnValue(mockChild);

      const config = makeConfig({ isUserLevel: false, name: 'kici-orchestrator' });
      await manager.logs(config, { follow: true });

      expect(mockedSpawn).toHaveBeenCalledWith(
        'tail',
        expect.arrayContaining(['-f']),
        expect.any(Object),
      );
    });
  });

  describe('component marker + list()', () => {
    it('writes KiCIComponent=orchestrator into the plist when component is set', async () => {
      const config = makeConfig({ isUserLevel: false, component: 'orchestrator' });
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') throw new Error('not loaded');
        return '';
      });
      await manager.install(config);

      const writtenContent = mockedWriteFileSync.mock.calls.find(
        (call: unknown[]) => call[0] === '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist',
      )?.[1] as string | undefined;

      expect(writtenContent).toBeDefined();
      expect(writtenContent).toMatch(/<key>KiCIComponent<\/key>\s*<string>orchestrator<\/string>/);
    });

    it('omits the KiCIComponent key when component is not set', () => {
      const config = makeConfig({ component: undefined });
      const plist = manager.generatePlist(config);

      expect(plist).not.toContain('KiCIComponent');
    });

    it('writes KiCIInstanceDir into the plist when instanceDir is set', () => {
      const config = makeConfig({ component: 'orchestrator', instanceDir: '/Users/u/kici-deploy' });
      const plist = manager.generatePlist(config);

      expect(plist).toMatch(
        /<key>KiCIInstanceDir<\/key>\s*<string>\/Users\/u\/kici-deploy<\/string>/,
      );
    });

    it('omits the KiCIInstanceDir key when instanceDir is not set', () => {
      const config = makeConfig({ component: 'orchestrator', instanceDir: undefined });
      const plist = manager.generatePlist(config);

      expect(plist).not.toContain('KiCIInstanceDir');
    });

    it('list(true) recovers instanceDir from the KiCIInstanceDir marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/Users/testuser/Library/LaunchAgents',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents') return ['com.kici.foo.plist'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents/com.kici.foo.plist') {
          return [
            '<plist version="1.0">',
            '<dict>',
            '  <key>KiCIComponent</key>',
            '  <string>orchestrator</string>',
            '  <key>KiCIInstanceDir</key>',
            '  <string>/Users/testuser/kici-foo</string>',
            '</dict>',
            '</plist>',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result).toContainEqual({
        name: 'com.kici.foo',
        platform: 'launchd',
        isUserLevel: true,
        component: 'orchestrator',
        instanceDir: '/Users/testuser/kici-foo',
      });
    });

    it('list(true) returns user-level plists with a valid KiCIComponent marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/Users/testuser/Library/LaunchAgents',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents') return ['com.kici.foo.plist'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents/com.kici.foo.plist') {
          return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<plist version="1.0">',
            '<dict>',
            '  <key>Label</key>',
            '  <string>com.kici.foo</string>',
            '  <key>KiCIComponent</key>',
            '  <string>agent</string>',
            '</dict>',
            '</plist>',
            '',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result).toContainEqual({
        name: 'com.kici.foo',
        platform: 'launchd',
        isUserLevel: true,
        component: 'agent',
      });
    });

    it('list(true) skips plists that do not carry a KiCIComponent marker', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/Users/testuser/Library/LaunchAgents',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents') return ['com.unrelated.plist'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents/com.unrelated.plist') {
          return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<plist version="1.0">',
            '<dict>',
            '  <key>Label</key>',
            '  <string>com.unrelated</string>',
            '</dict>',
            '</plist>',
            '',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(true);

      expect(result.find((r) => r.name === 'com.unrelated')).toBeUndefined();
    });

    it('list(false) scans /Library/LaunchDaemons for system-level plists', async () => {
      mockedExistsSync.mockImplementation((p: string) => p === '/Library/LaunchDaemons');
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/Library/LaunchDaemons') return ['dev.kici.sys-orch.plist'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/Library/LaunchDaemons/dev.kici.sys-orch.plist') {
          return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<plist version="1.0">',
            '<dict>',
            '  <key>Label</key>',
            '  <string>dev.kici.sys-orch</string>',
            '  <key>KiCIComponent</key>',
            '  <string>orchestrator</string>',
            '</dict>',
            '</plist>',
            '',
          ].join('\n');
        }
        return '';
      });

      const result = await manager.list(false);

      expect(result).toContainEqual({
        name: 'dev.kici.sys-orch',
        platform: 'launchd',
        isUserLevel: false,
        component: 'orchestrator',
      });
    });
  });

  describe('readLaunchSpec', () => {
    const config = makeConfig({ isUserLevel: true });

    it('parses ProgramArguments into execPath + args', async () => {
      mockedReadFileSync.mockReturnValueOnce(
        [
          '<plist version="1.0"><dict>',
          '  <key>ProgramArguments</key>',
          '  <array>',
          '    <string>/usr/local/bin/node</string>',
          '    <string>/usr/local/kici/x/@kici-dev/orchestrator/dist/server.js</string>',
          '  </array>',
          '</dict></plist>',
        ].join('\n'),
      );
      const spec = await manager.readLaunchSpec(config);
      expect(spec).toEqual({
        execPath: '/usr/local/bin/node',
        args: ['/usr/local/kici/x/@kici-dev/orchestrator/dist/server.js'],
      });
    });

    it('returns null when there is no ProgramArguments array', async () => {
      mockedReadFileSync.mockReturnValueOnce('<plist><dict></dict></plist>');
      expect(await manager.readLaunchSpec(config)).toBeNull();
    });

    it('returns null when the plist cannot be read', async () => {
      mockedReadFileSync.mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });
      expect(await manager.readLaunchSpec(config)).toBeNull();
    });
  });
});
