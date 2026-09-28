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
import { LaunchdServiceManager, stripLabelPrefix } from './launchd.js';

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
    vi.resetAllMocks();
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

    it('includes RunAtLoad', () => {
      const plist = manager.generatePlist(makeConfig());

      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    });

    it('keeps the job alive only after a failed exit, as Restart=on-failure does', () => {
      // fails-when: KeepAlive is `<true/>`, so launchd restarts a process that
      // exited 0 (an agent drain, a SIGTERM from outside launchd) forever.
      const plist = manager.generatePlist(makeConfig());

      expect(plist).toMatch(
        /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
      );
      expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    });

    it('omits KeepAlive and ThrottleInterval when the restart policy is disabled', () => {
      // breaks-if-wrong: a disabled policy still restarts the service, unlike
      // the systemd unit, which then carries no Restart= line.
      const plist = manager.generatePlist(
        makeConfig({
          restartPolicy: { enabled: false, delays: [1], maxRetries: 5, windowSeconds: 300 },
        }),
      );

      expect(plist).not.toContain('<key>KeepAlive</key>');
      expect(plist).not.toContain('<key>ThrottleInterval</key>');
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    });

    it("sets ExitTimeOut to the component's shutdown grace, above launchd's 5s default", () => {
      // fails-when: the plist has no ExitTimeOut, so `stop` (bootout) SIGKILLs
      // the process 5s after SIGTERM, partway through its graceful shutdown.
      const orch = manager.generatePlist(makeConfig({ component: 'orchestrator' }));
      expect(orch).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>45<\/integer>/);

      const agent = manager.generatePlist(makeConfig({ component: 'agent', name: 'kici-agent' }));
      expect(agent).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/);
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
        if (Array.isArray(args) && args[0] === 'print')
          throw Object.assign(new Error('not loaded'), { status: 113 });
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
        if (Array.isArray(args) && args[0] === 'print')
          throw Object.assign(new Error('not loaded'), { status: 113 });
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
          throw Object.assign(new Error('not loaded'), { status: 113 });
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
          throw Object.assign(new Error('not loaded'), { status: 113 });
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
          if (bootedOut) throw Object.assign(new Error('not loaded'), { status: 113 }); // unloaded after bootout
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
          throw Object.assign(new Error('not loaded'), { status: 113 }); // isLoaded === false throughout
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
          throw Object.assign(new Error('not loaded'), { status: 113 });
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
      const config = makeConfig({ isUserLevel: false, user: 'alice' });
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw Object.assign(new Error('not loaded'), { status: 113 });
        }
        return '';
      });
      await manager.install(config);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'chown',
        ['-R', 'alice:staff', '/var/log/kici'],
        expect.any(Object),
      );
    });

    it('skips the log-dir chown when installing user-level (homedir already owned)', async () => {
      const config = makeConfig({ isUserLevel: true });
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'print') {
          throw Object.assign(new Error('not loaded'), { status: 113 });
        }
        return '';
      });
      await manager.install(config);

      const chownCalls = mockedExecFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'chown');
      expect(chownCalls).toHaveLength(0);
    });
  });

  /**
   * Simulate launchd's view of one job. `print` answers while the job is
   * loaded; `bootout` unloads it (after `unloadAfterPrints` more `print` calls,
   * to model launchd's asynchronous teardown); `bootstrap` loads it. `fail`
   * makes one verb throw the given launchctl error.
   */
  function simulateLaunchd(opts: {
    loaded: boolean;
    /** Whether the job's plist is on disk (default true). */
    installed?: boolean;
    unloadAfterPrints?: number;
    /**
     * Make one verb throw this launchctl error. `once` fails only the first
     * call; `loadedAfter` sets the job's loaded state as the call fails,
     * modelling another caller that loaded or unloaded the job concurrently;
     * `unloadAfterPrints` makes the job leave the domain after that many more
     * prints, modelling an unload already in progress.
     */
    fail?: {
      verb: string;
      status: number;
      stderr: string;
      once?: boolean;
      loadedAfter?: boolean;
      unloadAfterPrints?: number;
    };
  }): { launchctlVerbs: () => unknown[][] } {
    let loaded = opts.loaded;
    let printsUntilUnloaded = -1;
    let failArmed = true;
    mockedExistsSync.mockReturnValue(opts.installed ?? true);
    mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
      if (bin !== 'launchctl' || !Array.isArray(args)) return '';
      const verb = args[0];
      if (opts.fail && verb === opts.fail.verb && failArmed) {
        if (opts.fail.once) failArmed = false;
        if (opts.fail.loadedAfter !== undefined) loaded = opts.fail.loadedAfter;
        if (opts.fail.unloadAfterPrints !== undefined) {
          printsUntilUnloaded = opts.fail.unloadAfterPrints;
        }
        throw Object.assign(new Error(`Command failed: launchctl ${args.join(' ')}`), {
          status: opts.fail.status,
          stderr: opts.fail.stderr,
        });
      }
      if (verb === 'print') {
        if (printsUntilUnloaded === 0) loaded = false;
        if (printsUntilUnloaded > 0) printsUntilUnloaded -= 1;
        if (!loaded) throw Object.assign(new Error('Could not find service'), { status: 113 });
        return '\tstate = running\n\tpid = 4321\n\tlast exit code = (never exited)\n';
      }
      if (verb === 'bootout') {
        if (!loaded) {
          throw Object.assign(new Error('Boot-out failed: 3: No such process'), { status: 3 });
        }
        printsUntilUnloaded = opts.unloadAfterPrints ?? 0;
        return '';
      }
      if (verb === 'bootstrap') {
        // launchd answers a bootstrap of a job that is still loaded with EIO.
        if (loaded) {
          throw Object.assign(new Error('Bootstrap failed: 5: Input/output error'), {
            status: 5,
            stderr: 'Bootstrap failed: 5: Input/output error\n',
          });
        }
        loaded = true;
        return '';
      }
      if ((verb === 'kill' || verb === 'kickstart') && !loaded) {
        throw Object.assign(new Error('Could not find service'), { status: 113 });
      }
      return '';
    });
    return {
      launchctlVerbs: () =>
        mockedExecFileSync.mock.calls
          .filter((c: unknown[]) => c[0] === 'launchctl')
          .map((c: unknown[]) => c[1] as unknown[]),
    };
  }

  describe('start', () => {
    it('kickstarts a loaded job without killing a running instance', async () => {
      // fails-when: start() keeps `kickstart -k`, which restarts a running service.
      const sim = simulateLaunchd({ loaded: true });
      await manager.start(makeConfig({ isUserLevel: false }));

      const verbs = sim.launchctlVerbs();
      expect(verbs).toContainEqual(['kickstart', 'system/dev.kici.kici-orchestrator']);
      expect(verbs.some((v) => v[0] === 'bootstrap')).toBe(false);
    });

    it('bootstraps the installed plist when the job is not loaded (after stop)', async () => {
      // fails-when: start() only kickstarts, which fails with 113 on an unloaded job.
      const sim = simulateLaunchd({ loaded: false });
      await manager.start(makeConfig({ isUserLevel: false }));

      const verbs = sim.launchctlVerbs();
      expect(verbs).toContainEqual([
        'bootstrap',
        'system',
        '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist',
      ]);
      expect(verbs.some((v) => v[0] === 'kickstart')).toBe(false);
    });

    it('targets the gui/<uid> domain for user-level services', async () => {
      const loadedSim = simulateLaunchd({ loaded: true });
      await manager.start(makeConfig({ isUserLevel: true }));
      expect(loadedSim.launchctlVerbs()).toContainEqual([
        'kickstart',
        'gui/501/dev.kici.kici-orchestrator',
      ]);

      vi.clearAllMocks();
      const unloadedSim = simulateLaunchd({ loaded: false });
      await manager.start(makeConfig({ isUserLevel: true }));
      expect(unloadedSim.launchctlVerbs()).toContainEqual([
        'bootstrap',
        'gui/501',
        '/Users/testuser/Library/LaunchAgents/dev.kici.kici-orchestrator.plist',
      ]);
    });

    it('leaves a job alone that another caller loaded while start was bootstrapping', async () => {
      // fails-when: start() retries a failed bootstrap by booting out whatever
      // is loaded (install's replace path), restarting the service it just
      // found running.
      const sim = simulateLaunchd({
        loaded: false,
        fail: {
          verb: 'bootstrap',
          status: 5,
          stderr: 'Bootstrap failed: 5: Input/output error\n',
          once: true,
          loadedAfter: true,
        },
      });
      await expect(manager.start(makeConfig())).resolves.toBeUndefined();
      expect(sim.launchctlVerbs().some((v) => v[0] === 'bootout')).toBe(false);
    });

    it('retries a bootstrap that hits the transient EIO right after an unload', async () => {
      vi.useFakeTimers();
      try {
        const sim = simulateLaunchd({
          loaded: false,
          fail: {
            verb: 'bootstrap',
            status: 5,
            stderr: 'Bootstrap failed: 5: Input/output error\n',
            once: true,
          },
        });
        const starting = manager.start(makeConfig());
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(starting).resolves.toBeUndefined();
        expect(sim.launchctlVerbs().filter((v) => v[0] === 'bootstrap')).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces a bootstrap failure', async () => {
      simulateLaunchd({
        loaded: false,
        fail: { verb: 'bootstrap', status: 22, stderr: 'Load failed: 22: Invalid argument\n' },
      });
      await expect(manager.start(makeConfig())).rejects.toThrow(/launchctl bootstrap/);
    });
  });

  describe('stop', () => {
    it('unloads a running job so KeepAlive cannot respawn it', async () => {
      // fails-when: stop() sends `kill TERM`, which KeepAlive answers with a respawn.
      const sim = simulateLaunchd({ loaded: true });
      await manager.stop(makeConfig({ isUserLevel: false }));

      const verbs = sim.launchctlVerbs();
      expect(verbs).toContainEqual(['bootout', 'system/dev.kici.kici-orchestrator']);
      expect(verbs.some((v) => v[0] === 'kill')).toBe(false);
    });

    it('waits until launchd has finished unloading the job before it returns', async () => {
      // launchctl bootout returns while the process is still shutting down.
      vi.useFakeTimers();
      try {
        const sim = simulateLaunchd({ loaded: true, unloadAfterPrints: 3 });
        let settled = false;
        const stopping = manager.stop(makeConfig()).then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;
        expect(settled).toBe(true);
        const prints = sim.launchctlVerbs().filter((v) => v[0] === 'print');
        expect(prints.length).toBeGreaterThanOrEqual(4);
      } finally {
        vi.useRealTimers();
      }
    });

    it('succeeds on a job that is already stopped (not loaded)', async () => {
      // fails-when: stop() runs `kill TERM` or `bootout` bare — both fail on an unloaded job.
      const sim = simulateLaunchd({ loaded: false });
      await expect(manager.stop(makeConfig())).resolves.toBeUndefined();
      expect(sim.launchctlVerbs().some((v) => v[0] === 'kill')).toBe(false);
    });

    it('surfaces a bootout failure that leaves the job loaded', async () => {
      // fails-when: stop() swallows every bootout error, as uninstall() does.
      vi.useFakeTimers();
      try {
        simulateLaunchd({
          loaded: true,
          fail: {
            verb: 'bootout',
            status: 1,
            stderr: 'Boot-out failed: 1: Operation not permitted\n',
          },
        });
        const assertion = expect(manager.stop(makeConfig())).rejects.toThrow(/launchctl bootout/);
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('succeeds when bootout fails because the job unloaded concurrently', async () => {
      // fails-when: stop() rethrows every bootout error, even when the job has
      // left the domain (another stop, or launchd finishing a teardown).
      simulateLaunchd({
        loaded: true,
        fail: {
          verb: 'bootout',
          status: 3,
          stderr: 'Boot-out failed: 3: No such process\n',
          loadedAfter: false,
        },
      });
      await expect(manager.stop(makeConfig())).resolves.toBeUndefined();
    });

    it('succeeds when bootout fails while launchd is still finishing an unload', async () => {
      // fails-when: stop() checks once after a failed bootout instead of
      // letting a teardown already in progress finish.
      vi.useFakeTimers();
      try {
        simulateLaunchd({
          loaded: true,
          // The job leaves the domain on the 4th print after the failed bootout (~1.5s).
          fail: {
            verb: 'bootout',
            status: 36,
            stderr: 'Boot-out failed: 36\n',
            unloadAfterPrints: 3,
          },
        });
        const stopping = manager.stop(makeConfig());
        const assertion = expect(stopping).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(4_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails on a job that is neither loaded nor installed', async () => {
      // fails-when: stop() reports success for a service with no job and no
      // plist, e.g. one addressed by the wrong label.
      simulateLaunchd({ loaded: false, installed: false });
      await expect(manager.stop(makeConfig())).rejects.toThrow(/not installed/);
    });

    it('surfaces a launchctl print failure instead of reporting the job stopped', async () => {
      // fails-when: isLoaded() reads every print failure as "not loaded", so
      // stop() returns and the CLI prints "stopped" for a job it never saw.
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (bin === 'launchctl' && Array.isArray(args) && args[0] === 'print') {
          throw Object.assign(new Error('Command failed: launchctl print'), { status: 1 });
        }
        return '';
      });
      await expect(manager.stop(makeConfig())).rejects.toThrow(/launchctl print/);
      const verbs = mockedExecFileSync.mock.calls.map((c: unknown[]) => (c[1] as unknown[])[0]);
      expect(verbs).not.toContain('bootout');
    });

    it('waits past the ExitTimeOut, then fails when the job is still loaded', async () => {
      vi.useFakeTimers();
      try {
        // bootout succeeds but launchd never finishes the teardown.
        simulateLaunchd({ loaded: true, unloadAfterPrints: Number.MAX_SAFE_INTEGER });
        let rejection: unknown;
        const stopping = manager
          .stop(makeConfig({ component: 'orchestrator' }))
          .catch((err: unknown) => {
            rejection = err;
          });
        // fails-when: the deadline is shorter than the plist's ExitTimeOut (45s
        // for the orchestrator), so stop gives up before launchd has SIGKILLed.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(rejection).toBeUndefined();
        await vi.advanceTimersByTimeAsync(30_000);
        await stopping;
        expect(String(rejection)).toMatch(/still loaded 60s after launchctl bootout/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('install over a running job', () => {
    it("waits for a shutdown as long as the job's grace before it bootstraps", async () => {
      // The running orchestrator takes 30s to shut down (within its 45s grace).
      // fails-when: install waits only 15s and then retries bootstrap for ~10s
      // more, so it bootstraps into a domain that still holds the job (EIO).
      vi.useFakeTimers();
      try {
        const sim = simulateLaunchd({ loaded: true, unloadAfterPrints: 60 });
        const installing = manager.install(makeConfig({ component: 'orchestrator' }));
        const assertion = expect(installing).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(70_000);
        await assertion;
        const verbs = sim.launchctlVerbs().filter((v) => v[0] !== 'print');
        expect(verbs).toEqual([
          ['bootout', 'system/dev.kici.kici-orchestrator'],
          ['bootstrap', 'system', '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist'],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('restart', () => {
    it('unloads the job, then bootstraps it again', async () => {
      // fails-when: start() kickstarts after stop() unloaded the job (113, nothing restarts).
      const sim = simulateLaunchd({ loaded: true });
      await manager.restart(makeConfig({ isUserLevel: false }));

      const verbs = sim.launchctlVerbs().filter((v) => v[0] !== 'print');
      expect(verbs).toEqual([
        ['bootout', 'system/dev.kici.kici-orchestrator'],
        ['bootstrap', 'system', '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist'],
      ]);
    });
  });

  describe('status', () => {
    /**
     * Answer `launchctl print` with `body` (or throw launchctl's exit code),
     * and `launchctl list` with an output that never names the job — what a
     * non-root caller sees for a system daemon.
     */
    function launchctlAnswers(print: { body: string } | { status: number }): void {
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (bin !== 'launchctl' || !Array.isArray(args)) return '';
        if (args[0] === 'print') {
          if ('status' in print) {
            throw Object.assign(new Error('Command failed: launchctl print'), {
              status: print.status,
            });
          }
          return print.body;
        }
        if (args[0] === 'list') return '123\t0\tcom.apple.something\n';
        return '';
      });
    }

    it("reads the job's own domain, which a non-root caller can see for a system daemon", async () => {
      // fails-when: status reads `launchctl list`, which lists only the
      // caller's domain, so a running system daemon reads as not loaded.
      launchctlAnswers({
        // A nested block ahead of the job's own lines repeats `pid` one tab
        // deeper; only the one-tab line belongs to the job.
        body:
          'system/dev.kici.kici-orchestrator = {\n' +
          '\tendpoints = {\n' +
          '\t\tstate = active\n' +
          '\t\tpid = 999\n' +
          '\t}\n' +
          '\tstate = running\n' +
          '\tpid = 12345\n' +
          '\tlast exit code = (never exited)\n' +
          '}\n',
      });
      mockedExistsSync.mockReturnValue(true);

      const result = await manager.status(makeConfig({ isUserLevel: false }));

      expect(result).toEqual({ state: 'running', pid: 12345 });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'launchctl',
        ['print', 'system/dev.kici.kici-orchestrator'],
        expect.any(Object),
      );
    });

    it('reports stopped for a loaded job that exited cleanly', async () => {
      launchctlAnswers({ body: '\tstate = not running\n\tlast exit code = 0\n' });

      const result = await manager.status(makeConfig());

      expect(result).toEqual({ state: 'stopped' });
    });

    it('reports failed for a loaded job whose last exit code is non-zero', async () => {
      launchctlAnswers({ body: '\tstate = not running\n\tlast exit code = 3\n' });

      const result = await manager.status(makeConfig());

      expect(result.state).toBe('failed');
    });

    it('reports failed for an exit code launchd prints with its name', async () => {
      // fails-when: the exit-code pattern is anchored at the end of the line,
      // so `78: EX_CONFIG` (a job that cannot spawn) reads as stopped.
      launchctlAnswers({ body: '\tstate = spawn scheduled\n\tlast exit code = 78: EX_CONFIG\n' });

      const result = await manager.status(makeConfig());

      expect(result.state).toBe('failed');
    });

    it('reports failed for a job a signal terminated', async () => {
      // fails-when: only `last exit code` is read, so a job killed by a signal
      // (launchd prints no exit code for it) reads as stopped.
      launchctlAnswers({ body: '\tstate = not running\n\tlast terminating signal = Killed: 9\n' });

      const result = await manager.status(makeConfig());

      expect(result.state).toBe('failed');
    });

    it('reports stopped for an installed job that is not loaded (the state stop leaves)', async () => {
      // fails-when: a job launchd does not know reads as unknown whatever is on disk.
      launchctlAnswers({ status: 113 });
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/Library/LaunchDaemons/dev.kici.kici-orchestrator.plist',
      );

      const result = await manager.status(makeConfig({ isUserLevel: false }));

      expect(result).toEqual({ state: 'stopped' });
    });

    it('reports unknown for a job that is neither loaded nor installed', async () => {
      launchctlAnswers({ status: 113 });
      mockedExistsSync.mockReturnValue(false);

      const result = await manager.status(makeConfig());

      expect(result.state).toBe('unknown');
    });

    it('reports unknown when launchctl print fails for another reason', async () => {
      // fails-when: every print failure is read as "not loaded", so an
      // installed service that cannot be inspected reads as stopped.
      launchctlAnswers({ status: 1 });
      mockedExistsSync.mockReturnValue(true);

      const result = await manager.status(makeConfig());

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

    it('keeps launchctl quiet about a job that stop already unloaded', async () => {
      // fails-when: the bootout inherits stderr, so `stop` then `uninstall`
      // prints "Boot-out failed: 3: No such process" to the operator.
      simulateLaunchd({ loaded: false });
      await expect(manager.uninstall(makeConfig())).resolves.toBeUndefined();

      const bootout = mockedExecFileSync.mock.calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && (c[1] as unknown[])[0] === 'bootout',
      );
      expect(bootout).toBeDefined();
      expect((bootout![2] as { stdio: unknown[] }).stdio[2]).toBe('pipe');
      expect(mockedUnlinkSync).toHaveBeenCalled();
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
        if (Array.isArray(args) && args[0] === 'print')
          throw Object.assign(new Error('not loaded'), { status: 113 });
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

      // The reported name is the SERVICE name, not the launchd label — that is
      // what `--name` addresses and what `resolve.ts` matches on.
      expect(result).toContainEqual({
        name: 'foo',
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

      // The reported name is the SERVICE name, not the launchd label — that is
      // what `--name` addresses and what `resolve.ts` matches on.
      expect(result).toContainEqual({
        name: 'foo',
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
        name: 'sys-orch',
        platform: 'launchd',
        isUserLevel: false,
        component: 'orchestrator',
      });
    });

    // A plist we could not read is not a plist that is gone. Skipping it drops
    // a live instance from the scan, and `listInstances` then prunes its index
    // row — the same defect as returning `[]` from the whole scan, one file at
    // a time. `chmod 000` on an installed plist is the failing input.
    //
    // fails-when: the per-file catch goes back to an unconditional `continue`
    // — `list(true)` resolves to `[]` and `rejects.toThrow` fails.
    it('list() throws when a plist cannot be read for any reason but removal', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/Users/testuser/Library/LaunchAgents',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents') return ['com.kici.locked.plist'];
        return [];
      });
      mockedReadFileSync.mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('EACCES: permission denied, open');
        err.code = 'EACCES';
        throw err;
      });

      await expect(manager.list(true)).rejects.toThrow(/could not read the launchd job at/);
      await expect(manager.list(true)).rejects.toThrow(/com\.kici\.locked\.plist/);
    });

    // breaks-if-wrong: the removal-mid-scan case the original skip existed for
    // must still skip. A plist that vanished between the readdir and the read
    // is genuinely not installed, so throwing there would drop the whole
    // launchd scan on an ordinary concurrent uninstall.
    //
    // fails-when: the ENOENT branch is dropped and every read failure throws.
    it('list() skips a plist that vanished between the readdir and the read', async () => {
      mockedExistsSync.mockImplementation(
        (p: string) => p === '/Users/testuser/Library/LaunchAgents',
      );
      mockedReaddirSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents')
          return ['com.kici.gone.plist', 'com.kici.foo.plist'];
        return [];
      });
      mockedReadFileSync.mockImplementation((p: string) => {
        if (p === '/Users/testuser/Library/LaunchAgents/com.kici.gone.plist') {
          const err: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory, open');
          err.code = 'ENOENT';
          throw err;
        }
        return [
          '<plist version="1.0">',
          '<dict>',
          '  <key>KiCIComponent</key>',
          '  <string>orchestrator</string>',
          '</dict>',
          '</plist>',
        ].join('\n');
      });

      // The surviving sibling is what proves the scan continued past the gap
      // rather than aborting: an empty-array assertion would pass either way.
      await expect(manager.list(true)).resolves.toEqual([
        {
          name: 'foo',
          platform: 'launchd',
          isUserLevel: true,
          component: 'orchestrator',
          instanceDir: undefined,
        },
      ]);
    });
  });

  describe('an instance whose plist carries another label', () => {
    // list() reports com.kici.foo.plist, or a marked foo.plist, as instance "foo".
    const DIR = '/Library/LaunchDaemons';
    const CANONICAL_PLIST = `${DIR}/dev.kici.foo.plist`;
    const LEGACY_PLIST = `${DIR}/com.kici.foo.plist`;
    const config = makeConfig({ name: 'foo', isUserLevel: false });

    function plistFor(label: string, { marked = true } = {}): string {
      return [
        '<plist version="1.0"><dict>',
        '  <key>Label</key>',
        `  <string>${label}</string>`,
        ...(marked ? ['  <key>KiCIComponent</key>', '  <string>orchestrator</string>'] : []),
        '  <key>ProgramArguments</key>',
        '  <array>',
        `    <string>/opt/${label}/kici-orchestrator</string>`,
        '  </array>',
        '</dict></plist>',
      ].join('\n');
    }

    /**
     * Put `files` (plist path -> content) on disk and simulate launchd, which
     * holds each job under the Label its plist declares.
     */
    function onDisk(
      files: Record<string, string>,
      loaded: string[],
    ): { verbs: () => unknown[][]; loaded: Set<string> } {
      const jobs = new Set(loaded);
      mockedExistsSync.mockImplementation((p: string) => p in files);
      mockedReadFileSync.mockImplementation((p: string) => files[p] ?? '');
      mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
        if (bin !== 'launchctl' || !Array.isArray(args)) return '';
        const target = String(args[1]).replace(/^system\//, '');
        if (args[0] === 'print') {
          if (!jobs.has(target)) throw Object.assign(new Error('not loaded'), { status: 113 });
          return '\tstate = running\n\tpid = 77\n';
        }
        if (args[0] === 'bootout') jobs.delete(target);
        if (args[0] === 'bootstrap') {
          const label = /<string>([^<]+)<\/string>/.exec(files[String(args[2])] ?? '')?.[1];
          if (label) jobs.add(label);
        }
        return '';
      });
      return {
        loaded: jobs,
        verbs: () =>
          mockedExecFileSync.mock.calls
            .filter((c: unknown[]) => c[0] === 'launchctl')
            .map((c: unknown[]) => c[1] as unknown[])
            .filter((v) => v[0] !== 'print'),
      };
    }

    it('stop unloads the job under the label its plist carries', async () => {
      // fails-when: stop() targets dev.kici.foo and answers "not installed".
      const sim = onDisk({ [LEGACY_PLIST]: plistFor('com.kici.foo') }, ['com.kici.foo']);

      await manager.stop(config);

      expect(sim.verbs()).toEqual([['bootout', 'system/com.kici.foo']]);
      expect(sim.loaded.has('com.kici.foo')).toBe(false);
    });

    it('start loads the plist it found, and status reads the job it loaded', async () => {
      const sim = onDisk({ [LEGACY_PLIST]: plistFor('com.kici.foo') }, []);

      await manager.start(config);

      expect(sim.verbs()).toEqual([['bootstrap', 'system', LEGACY_PLIST]]);
      expect(await manager.status(config)).toEqual({ state: 'running', pid: 77 });
      expect(await manager.isInstalled(config)).toBe(true);
      expect(await manager.readLaunchSpec(config)).toEqual({
        execPath: '/opt/com.kici.foo/kici-orchestrator',
        args: [],
      });
    });

    it('restart and uninstall act on the same job', async () => {
      const sim = onDisk({ [LEGACY_PLIST]: plistFor('com.kici.foo') }, ['com.kici.foo']);

      await manager.restart(config);
      await manager.uninstall(config);

      expect(sim.verbs()).toEqual([
        ['bootout', 'system/com.kici.foo'],
        ['bootstrap', 'system', LEGACY_PLIST],
        ['bootout', 'system/com.kici.foo'],
      ]);
      expect(mockedUnlinkSync).toHaveBeenCalledWith(LEGACY_PLIST);
    });

    it('resolves a marked plist that carries no prefix, under its declared Label', async () => {
      const sim = onDisk({ [`${DIR}/foo.plist`]: plistFor('org.example.foo') }, [
        'org.example.foo',
      ]);

      await manager.stop(config);

      expect(sim.verbs()).toEqual([['bootout', 'system/org.example.foo']]);
    });

    it('does not act on a plist that carries no KiCI component marker', async () => {
      // breaks-if-wrong: a same-named plist KiCI did not install is unloaded.
      const sim = onDisk({ [`${DIR}/foo.plist`]: plistFor('foo', { marked: false }) }, ['foo']);

      await expect(manager.stop(config)).rejects.toThrow(/dev\.kici\.foo is not installed/);
      expect(sim.loaded.has('foo')).toBe(true);
    });

    it('prefers the dev.kici plist when both are installed', async () => {
      // breaks-if-wrong: the canonical job is left running and the legacy one unloaded.
      const sim = onDisk(
        { [CANONICAL_PLIST]: plistFor('dev.kici.foo'), [LEGACY_PLIST]: plistFor('com.kici.foo') },
        ['dev.kici.foo'],
      );

      await manager.stop(config);

      expect(sim.verbs()).toEqual([['bootout', 'system/dev.kici.foo']]);
    });

    it('install moves the instance to dev.kici.<name>: the old job is unloaded and its plist removed', async () => {
      // fails-when: install leaves com.kici.foo loaded beside the new job, so
      // two processes run the same instance and fight over its port.
      const files: Record<string, string> = { [LEGACY_PLIST]: plistFor('com.kici.foo') };
      const sim = onDisk(files, ['com.kici.foo']);
      mockedWriteFileSync.mockImplementation((p: string, content: string) => {
        files[p] = content;
      });
      mockedUnlinkSync.mockImplementation((p: string) => {
        delete files[p];
      });

      await manager.install(config);

      expect(sim.verbs()).toEqual([
        ['bootout', 'system/com.kici.foo'],
        ['bootstrap', 'system', CANONICAL_PLIST],
      ]);
      expect(mockedUnlinkSync).toHaveBeenCalledWith(LEGACY_PLIST);
      expect([...sim.loaded]).toEqual(['dev.kici.foo']);
    });

    it('install that cannot unload the old job leaves the instance on its old plist', async () => {
      // fails-when: install writes dev.kici.foo.plist before it unloads
      // com.kici.foo. A failed unload then leaves both plists, stop resolves
      // the unloaded dev.kici job and reports success, and com.kici.foo runs on.
      vi.useFakeTimers();
      try {
        const files: Record<string, string> = { [LEGACY_PLIST]: plistFor('com.kici.foo') };
        onDisk(files, ['com.kici.foo']);
        const simulate = mockedExecFileSync.getMockImplementation() as (
          bin: unknown,
          args: unknown,
        ) => unknown;
        mockedExecFileSync.mockImplementation((bin: unknown, args: unknown) => {
          if (bin === 'launchctl' && Array.isArray(args) && args[0] === 'bootout') {
            throw Object.assign(new Error('Boot-out failed: 1: Operation not permitted'), {
              status: 1,
              stderr: '',
            });
          }
          return simulate(bin, args);
        });
        mockedWriteFileSync.mockImplementation((p: string, content: string) => {
          files[p] = content;
        });

        const installing = manager.install(config);
        const assertion = expect(installing).rejects.toThrow(/Operation not permitted/);
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;

        expect(files[CANONICAL_PLIST]).toBeUndefined();

        // stop still acts on the running com.kici.foo job.
        mockedExecFileSync.mockClear();
        const stopping = manager.stop(config).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(10_000);
        await stopping;
        const bootouts = mockedExecFileSync.mock.calls
          .filter((c: unknown[]) => Array.isArray(c[1]) && (c[1] as unknown[])[0] === 'bootout')
          .map((c: unknown[]) => (c[1] as unknown[])[1]);
        expect(bootouts).toContain('system/com.kici.foo');
        expect(bootouts).not.toContain('system/dev.kici.foo');
      } finally {
        vi.useRealTimers();
      }
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

describe('stripLabelPrefix', () => {
  it('strips the current reverse-DNS prefix', () => {
    expect(stripLabelPrefix('dev.kici.kici-orch-macos')).toBe('kici-orch-macos');
  });

  it('strips the historical com.kici prefix', () => {
    // Hosts upgraded across the rename carry plists under the old label.
    expect(stripLabelPrefix('com.kici.my-orch')).toBe('my-orch');
  });

  it('leaves an unprefixed label alone', () => {
    // A hand-written plist stays discoverable under whatever label it uses.
    expect(stripLabelPrefix('my-orch')).toBe('my-orch');
  });

  it('strips only the leading prefix, not an embedded one', () => {
    expect(stripLabelPrefix('dev.kici.a.dev.kici.b')).toBe('a.dev.kici.b');
  });
});
