/**
 * Tests for the Windows service manager.
 *
 * Mocks child_process.execSync and fs operations to test service
 * lifecycle commands via shawl + sc.exe without requiring Windows.
 */

import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceConfig } from './types.js';
import { DEFAULT_RESTART_POLICY } from './types.js';
import { restrictDirArgs } from './windows-acl.js';

// Mock child_process
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Mock fs
const mockExistsSync = vi.fn(() => false);
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockRmSync = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
      rmSync: (...args: unknown[]) => mockRmSync(...args),
    },
  };
});

// Mock lazy deps
const mockEnsureDep = vi.fn().mockResolvedValue('/cache/shawl/1.5.2');
const mockGetDepMetadata = vi.fn().mockReturnValue({
  name: 'shawl',
  version: '1.5.2',
  platform: 'win32',
  arch: 'x64',
  url: 'https://example.com/shawl.zip',
  sha256: 'abc123',
  extractPath: 'shawl.exe',
  archiveType: 'zip',
});
vi.mock('../lazy-deps/downloader.js', () => ({
  ensureDep: (...args: unknown[]) => mockEnsureDep(...args),
}));
vi.mock('../lazy-deps/registry.js', () => ({
  getDepMetadata: (...args: unknown[]) => mockGetDepMetadata(...args),
}));

// Mock platform-detect
vi.mock('./platform-detect.js', () => ({
  getCacheDir: () => '/cache/',
}));

const testConfig: ServiceConfig = {
  name: 'kici-orchestrator',
  displayName: 'KiCI Orchestrator',
  description: 'KiCI orchestrator service',
  executablePath: 'C:\\Program Files\\kici\\kici-orchestrator.exe',
  envFilePath: 'C:\\ProgramData\\kici\\kici-orchestrator.env',
  workingDirectory: 'C:\\Program Files\\kici',
  isUserLevel: false,
  restartPolicy: DEFAULT_RESTART_POLICY,
};

describe('WindowsServiceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    // Fresh-box default: no pre-existing service, so `sc.exe query` throws
    // (exit non-zero). This makes install()'s serviceExists() guard return
    // false so the happy-path install tests run unchanged; everything else
    // succeeds silently. Tests that need a different shape override this with
    // their own mockReturnValueOnce / mockImplementation.
    mockExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
        throw new Error('service does not exist');
      }
      return '';
    });
  });

  describe('install', () => {
    it('downloads shawl via lazy deps', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      expect(mockGetDepMetadata).toHaveBeenCalledWith('shawl');
      expect(mockEnsureDep).toHaveBeenCalled();
    });

    it('creates env file directory', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      // path.dirname behaves differently on Linux vs Windows for backslash paths,
      // so we just verify mkdirSync was called with recursive: true
      expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('runs shawl add with correct arguments', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      // Find the shawl add call
      const shawlCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('shawl'),
      );
      expect(shawlCall).toBeDefined();
      const cmd = shawlCall![0] as string;
      expect(cmd).toContain('shawl.exe');
      expect(cmd).toContain('add');
      expect(cmd).toContain('--name');
      expect(cmd).toContain('kici-orchestrator');
      expect(cmd).toContain('--cwd');
      expect(cmd).toContain('--env');
    });

    /** Serve `files` through existsSync and readFileSync; every other path is absent. */
    async function serveFiles(files: Record<string, string>): Promise<void> {
      mockExistsSync.mockImplementation(((p: unknown) => String(p) in files) as never);
      const fs = await import('node:fs');
      vi.spyOn(fs.default, 'readFileSync').mockImplementation(((p: unknown, enc?: unknown) => {
        const content = files[String(p)];
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' });
        }
        return enc ? content : Buffer.from(content);
      }) as never);
    }

    // fails-when: any env-file value reaches the shawl command line, which any
    // local account reads back with `sc.exe qc`.
    it('registers the env file path and none of its values', async () => {
      const SENTINEL = 'sentinel-secret-5d1e0b';
      await serveFiles({
        [testConfig.envFilePath]:
          `KICI_SECRET_KEY=${SENTINEL}\nKICI_DATABASE_URL=postgres://u:${SENTINEL}@db/k\n` +
          `PATH=C:\\${SENTINEL}\n`,
      });

      const { WindowsServiceManager } = await import('./windows.js');
      await new WindowsServiceManager().install(testConfig);

      const cmd = shawlAddCommand();
      // Positive control: the registration does carry an environment, the pointer.
      expect(cmd).toContain(`--env "KICI_ENV_FILE=${testConfig.envFilePath}"`);
      expect(cmd).not.toContain(SENTINEL);
      expect(cmd).not.toContain('--path-prepend');
      for (const call of [...mockExecSync.mock.calls, ...mockExecFileSync.mock.calls]) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    });

    /** The icacls in the Windows system folder, never one found on the current folder. */
    const ICACLS = expect.stringMatching(/\\System32\\icacls\.exe$/);

    it('restricts the env file folder before it creates the log folder and registers the service', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      await new WindowsServiceManager().install(testConfig);

      const dir = path.win32.dirname(testConfig.envFilePath);
      expect(mockExecFileSync.mock.calls.map((c: unknown[]) => c[1])).toEqual([
        restrictDirArgs(dir),
      ]);
      expect(mockExecFileSync).toHaveBeenCalledWith(ICACLS, expect.any(Array), expect.anything());
      const aclOrder = mockExecFileSync.mock.invocationCallOrder[0]!;
      const shawlIndex = mockExecSync.mock.calls.findIndex((c: unknown[]) =>
        String(c[0]).includes('shawl.exe" add'),
      );
      expect(aclOrder).toBeLessThan(mockExecSync.mock.invocationCallOrder[shawlIndex]!);
      const logMkdirIndex = mockMkdirSync.mock.calls.findIndex((c: unknown[]) =>
        String(c[0]).endsWith('logs'),
      );
      expect(aclOrder).toBeLessThan(mockMkdirSync.mock.invocationCallOrder[logMkdirIndex]!);
    });

    // fails-when: the folder is restricted after the old service is removed, so
    // an icacls failure during an upgrade leaves the host with no service.
    it('leaves the installed service in place when the folder cannot be restricted', async () => {
      mockExecSync.mockImplementation(() => Buffer.from('')); // the service exists
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Access is denied.');
      });
      const { WindowsServiceManager } = await import('./windows.js');

      await expect(new WindowsServiceManager().install(testConfig)).rejects.toThrow(
        /could not restrict access to C:\\ProgramData\\kici: Access is denied/,
      );
      const calls = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c) => c.includes('sc.exe stop') || c.includes('sc.exe delete'))).toBe(
        false,
      );
      expect(calls.some((c) => c.includes('shawl'))).toBe(false);
    });

    // breaks-if-wrong: a user-level folder in the profile of its user is
    // already private, and restricting it would lock that user out.
    it('leaves the ACL of a user-level folder alone', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      await new WindowsServiceManager().install({ ...testConfig, isUserLevel: true });

      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(shawlAddCommand()).toContain('--env "KICI_ENV_FILE=');
    });

    describe('a KiCI package launcher', () => {
      const PKG = 'C:\\Program Files\\KiCI\\kici-orchestrator\\orchestrator-0.11.0';
      const LAUNCHER = `${PKG}\\kici-orchestrator-standalone.cmd`;
      const BUNDLE = `${PKG}\\lib\\kici-orchestrator-standalone.cjs`;

      // fails-when: a release that cannot read KICI_ENV_FILE is registered, with
      // the pointer (the service starts without its configuration) or with the
      // values on its command line (any local account reads them).
      it('refuses a release that predates KICI_ENV_FILE before it changes anything', async () => {
        mockExecSync.mockImplementation(() => Buffer.from('')); // the service exists
        await serveFiles({
          [BUNDLE]: 'require("node:fs"); // a bundle with no env-file loader',
          [testConfig.envFilePath]: 'KICI_PORT=10043\n',
        });

        const { WindowsServiceManager } = await import('./windows.js');
        await expect(
          new WindowsServiceManager().install({ ...testConfig, executablePath: LAUNCHER }),
        ).rejects.toThrow(`cannot register ${testConfig.name}: ${LAUNCHER} predates KICI_ENV_FILE`);

        // The installed service, its folder and its ACL are left as they were.
        expect(mockExecSync).not.toHaveBeenCalled();
        expect(mockExecFileSync).not.toHaveBeenCalled();
        expect(mockMkdirSync).not.toHaveBeenCalled();
      });

      // fails-when: the npm entry of a release from before KICI_ENV_FILE is
      // registered, which an npm-source downgrade would otherwise do.
      it('refuses an npm entry that predates KICI_ENV_FILE', async () => {
        const ENTRY =
          'C:\\npm\\node_modules\\kici-admin\\node_modules\\@kici-dev\\agent\\dist\\server.js';
        await serveFiles({ [ENTRY]: 'import "./app.js"; // no env-file loader' });

        const { WindowsServiceManager } = await import('./windows.js');
        await expect(
          new WindowsServiceManager().install({
            ...testConfig,
            executablePath: 'C:\\Program Files\\nodejs\\node.exe',
            args: [ENTRY],
          }),
        ).rejects.toThrow(`${ENTRY} predates KICI_ENV_FILE`);
        expect(mockExecSync).not.toHaveBeenCalled();
      });

      // breaks-if-wrong: the npm entry of every release that reads
      // KICI_ENV_FILE is registered with the pointer.
      it('registers the pointer for an npm entry that imports the env-file loader', async () => {
        const ENTRY =
          'C:\\npm\\node_modules\\kici-admin\\node_modules\\@kici-dev\\agent\\dist\\server.js';
        await serveFiles({ [ENTRY]: 'import "@kici-dev/shared/load-service-env-file";' });

        const { WindowsServiceManager } = await import('./windows.js');
        await new WindowsServiceManager().install({
          ...testConfig,
          executablePath: 'C:\\Program Files\\nodejs\\node.exe',
          args: [ENTRY],
        });

        expect(shawlAddCommand()).toContain(`--env "KICI_ENV_FILE=${testConfig.envFilePath}"`);
      });

      // breaks-if-wrong: the launcher of every release that reads KICI_ENV_FILE
      // keeps its values off the command line.
      it('registers the pointer for a release whose bundle reads KICI_ENV_FILE', async () => {
        await serveFiles({
          [BUNDLE]: 'const SERVICE_ENV_FILE_VAR = "KICI_ENV_FILE";',
          [testConfig.envFilePath]: 'KICI_PORT=10043\n',
        });

        const { WindowsServiceManager } = await import('./windows.js');
        await new WindowsServiceManager().install({ ...testConfig, executablePath: LAUNCHER });

        const cmd = shawlAddCommand();
        expect(cmd).toContain(`--env "KICI_ENV_FILE=${testConfig.envFilePath}"`);
        expect(cmd).not.toContain('KICI_PORT');
      });

      it('registers the pointer for a batch file with no KiCI bundle beside it', async () => {
        await serveFiles({ [testConfig.envFilePath]: 'KICI_PORT=10043\n' });

        const { WindowsServiceManager } = await import('./windows.js');
        await new WindowsServiceManager().install({ ...testConfig, executablePath: LAUNCHER });

        expect(shawlAddCommand()).toContain('--env "KICI_ENV_FILE=');
        expect(shawlAddCommand()).not.toContain('KICI_PORT');
      });
    });

    it('appends args after the executable in the shawl command', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({
        ...testConfig,
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['C:\\kici\\dist\\server.js'],
      });

      const shawlCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('shawl'),
      );
      const cmd = shawlCall![0] as string;
      expect(cmd).toContain('-- "C:\\Program Files\\nodejs\\node.exe" "C:\\kici\\dist\\server.js"');
    });

    /** The `shawl add` command line install() ran. */
    function shawlAddCommand(): string {
      const call = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('shawl.exe" add'),
      );
      expect(call).toBeDefined();
      return call![0] as string;
    }

    it("gives the process the component's shutdown grace before shawl kills it", async () => {
      // fails-when: no --stop-timeout, so shawl kills the process 3000 ms after
      // the ctrl-C, partway through the orchestrator's graceful shutdown.
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();

      await mgr.install({ ...testConfig, component: 'orchestrator' });
      expect(shawlAddCommand()).toContain(' --stop-timeout 45000 ');

      mockExecSync.mockClear();
      await mgr.install({ ...testConfig, name: 'kici-agent', component: 'agent' });
      expect(shawlAddCommand()).toContain(' --stop-timeout 20000 ');
    });

    it('runs a batch-file launcher through cmd.exe with stdin from NUL', async () => {
      // fails-when: shawl runs the .cmd directly. The ctrl-C leaves cmd.exe
      // waiting on "Terminate batch job (Y/N)?" after node exits, so every stop
      // lasts the whole --stop-timeout and ends with shawl killing cmd.exe.
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({
        ...testConfig,
        executablePath: 'C:\\Program Files\\KiCI\\orch\\kici-orchestrator-standalone.cmd',
      });

      expect(shawlAddCommand()).toMatch(
        /-- "C:\\Windows\\System32\\cmd\.exe" "\/d" "\/e:on" "\/v:off" "\/c" "call" "C:\\Program Files\\KiCI\\orch\\kici-orchestrator-standalone\.cmd" "<NUL"$/,
      );
    });

    it('recognises a batch file by its extension in any case', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({ ...testConfig, executablePath: 'C:\\kici\\run.BAT' });

      expect(shawlAddCommand()).toContain('"call" "C:\\kici\\run.BAT" "<NUL"');
    });

    it('runs any other executable directly', async () => {
      // breaks-if-wrong: node.exe (the install default) is wrapped in cmd.exe too.
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({
        ...testConfig,
        executablePath: 'C:\\node\\node.exe',
        args: ['C:\\kici\\dist\\server.js'],
      });

      const cmd = shawlAddCommand();
      expect(cmd).toMatch(/-- "C:\\node\\node\.exe" "C:\\kici\\dist\\server\.js"$/);
      expect(cmd).not.toContain('cmd.exe');
    });

    it('refuses a batch-file path cmd.exe would re-read, before it touches the installed service', async () => {
      // fails-when: the path reaches cmd.exe, which splits it at the `&`, the `(`
      // or a `,` `;` `=` delimiter (the service then crash-loops) or expands the `%`.
      // A service of this name is installed: the refusal must leave it in place.
      mockExecSync.mockImplementation(() => Buffer.from(''));
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();

      for (const executablePath of [
        'C:\\a&b\\kici.cmd',
        'C:\\100%\\kici.cmd',
        'C:\\x^y\\k.cmd',
        'C:\\tools(1)\\k.cmd',
        'C:\\ci,prod\\k.cmd',
        'C:\\a;b\\k.cmd',
        'C:\\a=b\\k.cmd',
      ]) {
        await expect(mgr.install({ ...testConfig, executablePath })).rejects.toThrow(/cmd\.exe/);
      }
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('runs the cmd.exe that COMSPEC names, and no other shell', async () => {
      // breaks-if-wrong: a COMSPEC naming another shell gets cmd.exe's wrapper
      // arguments, and readLaunchSpec no longer recognises the wrapper.
      const saved = process.env.COMSPEC;
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      try {
        process.env.COMSPEC = 'D:\\WINNT\\system32\\cmd.exe';
        await mgr.install({ ...testConfig, executablePath: 'C:\\kici\\run.cmd' });
        expect(shawlAddCommand()).toContain('-- "D:\\WINNT\\system32\\cmd.exe" "/d"');

        mockExecSync.mockClear();
        process.env.COMSPEC = 'C:\\tcc\\tcc.exe';
        await mgr.install({ ...testConfig, executablePath: 'C:\\kici\\run.cmd' });
        expect(shawlAddCommand()).toContain('-- "C:\\Windows\\System32\\cmd.exe" "/d"');
      } finally {
        if (saved === undefined) delete process.env.COMSPEC;
        else process.env.COMSPEC = saved;
      }
    });

    it('accepts a batch-file path whose special characters sit inside its quoted form', async () => {
      // breaks-if-wrong: an install under "Program Files (x86)" is refused. A
      // path with a space is quoted on the command line, where cmd.exe reads
      // `(`, `)` and `&` literally.
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({
        ...testConfig,
        executablePath: 'C:\\Program Files (x86)\\A & B, C=D\\kici.cmd',
      });

      expect(shawlAddCommand()).toContain('"call" "C:\\Program Files (x86)\\A & B, C=D\\kici.cmd"');
    });

    it('configures auto-start via sc.exe', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      const scConfigCall = mockExecSync.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).includes('sc.exe config') &&
          (c[0] as string).includes('start= auto'),
      );
      expect(scConfigCall).toBeDefined();
    });

    it('configures failure recovery via sc.exe', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      const failureCall = mockExecSync.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).includes('sc.exe failure') &&
          (c[0] as string).includes('restart/'),
      );
      expect(failureCall).toBeDefined();
    });

    it('removes a pre-existing service before re-installing (idempotent, no 1073)', async () => {
      // sc.exe query: present on the guard check, then gone during the uninstall poll.
      let queryCalls = 0;
      mockExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          queryCalls += 1;
          if (queryCalls === 1) return ''; // guard check: exit 0 → service EXISTS
          throw new Error('service does not exist'); // uninstall poll: gone
        }
        return ''; // stop/delete/description/config/failure/shawl add all succeed
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await expect(mgr.install(testConfig)).resolves.toBeUndefined();

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c) => c.includes('sc.exe delete'))).toBe(true); // uninstall ran
      expect(calls.some((c) => c.includes('shawl') && c.includes('add'))).toBe(true); // reinstall ran

      mockExecSync.mockReset();
    });

    it('skips uninstall on a fresh box (service absent) and runs shawl add', async () => {
      mockExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          throw new Error('service does not exist'); // ABSENT
        }
        return '';
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calls.some((c) => c.includes('sc.exe delete'))).toBe(false); // no uninstall
      expect(calls.some((c) => c.includes('shawl') && c.includes('add'))).toBe(true);

      mockExecSync.mockReset();
    });
  });

  describe('start', () => {
    it('polls until STOPPED, then runs sc.exe start', async () => {
      // Mock sc.exe query to return STOPPED (code 1) so the pre-start wait loop exits.
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 1  STOPPED\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.start(testConfig);

      expect(mockExecSync).toHaveBeenCalledWith('sc.exe start kici-orchestrator', {
        stdio: 'pipe',
      });

      mockExecSync.mockReset();
    });

    it('is a no-op when the service is already RUNNING', async () => {
      // Mock sc.exe query to return RUNNING (code 4). start() must NOT call sc.exe start —
      // calling it on a running service would fail with error 1056.
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 4  RUNNING\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.start(testConfig);

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).not.toContain('sc.exe start kici-orchestrator');

      mockExecSync.mockReset();
    });
  });

  describe('stop', () => {
    it('runs sc.exe stop, then polls until STOPPED', async () => {
      // Mock sc.exe query to return STOPPED (code 1) so the post-stop wait loop exits.
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 1  STOPPED\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.stop(testConfig);

      expect(mockExecSync).toHaveBeenCalledWith('sc.exe stop kici-orchestrator', {
        stdio: 'pipe',
      });
      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      const stopIdx = calls.indexOf('sc.exe stop kici-orchestrator');
      const queryIdx = calls.findIndex(
        (c: string) => typeof c === 'string' && c.includes('sc.exe query'),
      );
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(queryIdx).toBeGreaterThan(stopIdx);

      mockExecSync.mockReset();
    });

    /** The error `execSync` throws for a failed `sc.exe stop`: sc.exe prints its reason on stdout. */
    function scFailure(code: number, reason: string): Error {
      return Object.assign(new Error(`Command failed: sc.exe stop kici-orchestrator`), {
        status: code,
        stdout: Buffer.from(`[SC] ControlService FAILED ${code}:\r\n\r\n${reason}\r\n\r\n`),
        stderr: Buffer.from(''),
      });
    }

    it('succeeds on a service that is already stopped (1062, query confirms STOPPED)', async () => {
      // fails-when: stop() runs `sc.exe stop` bare — 1062 propagates and the call rejects.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'sc.exe stop kici-orchestrator') {
          throw scFailure(1062, 'The service has not been started.');
        }
        if (cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 1  STOPPED\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await expect(mgr.stop(testConfig)).resolves.toBeUndefined();

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContain('sc.exe query kici-orchestrator');

      mockExecSync.mockReset();
    });

    it('rethrows 1062 when the query does not confirm STOPPED', async () => {
      // fails-when: 1062 is swallowed on the error code alone, without the state check.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'sc.exe stop kici-orchestrator') {
          throw scFailure(1062, 'The service has not been started.');
        }
        if (cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 4  RUNNING\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await expect(mgr.stop(testConfig)).rejects.toThrow(/sc\.exe stop kici-orchestrator/);

      mockExecSync.mockReset();
    });

    /** `sc.exe query` answers STOP_PENDING until `stoppedAfterMs` has passed, then STOPPED. */
    function stopsAfter(stoppedAfterMs: number): void {
      const start = Date.now();
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('sc.exe query')) {
          const state = Date.now() - start >= stoppedAfterMs ? '1  STOPPED' : '3  STOP_PENDING';
          return Buffer.from(`        STATE              : ${state}\r\n`);
        }
        return Buffer.from('');
      });
    }

    it("waits for a shutdown as long as the component's grace", async () => {
      // The orchestrator takes 40s to stop, within its 45s grace.
      // fails-when: stop() gives up after 30s and reports a service that is
      // still shutting down as hung.
      vi.useFakeTimers();
      try {
        stopsAfter(40_000);
        const { WindowsServiceManager } = await import('./windows.js');
        const stopping = new WindowsServiceManager().stop({
          ...testConfig,
          component: 'orchestrator',
        });
        const assertion = expect(stopping).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(41_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a service still stopping after its grace and a margin', async () => {
      vi.useFakeTimers();
      try {
        stopsAfter(Number.MAX_SAFE_INTEGER);
        const { WindowsServiceManager } = await import('./windows.js');
        let rejection: unknown;
        const stopping = new WindowsServiceManager()
          .stop({ ...testConfig, name: 'kici-agent', component: 'agent' })
          .catch((err: unknown) => {
            rejection = err;
          });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(rejection).toBeUndefined();
        await vi.advanceTimersByTimeAsync(10_000);
        await stopping;
        expect(String(rejection)).toMatch(/did not reach STOPPED state within 35s/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits out a stop already in progress (1061 while STOP_PENDING), so restart succeeds', async () => {
      // fails-when: 1061 is rethrown, so `restart` on a service that is already
      // stopping fails instead of waiting for STOPPED and starting it again.
      vi.useFakeTimers();
      try {
        const start = Date.now();
        mockExecSync.mockImplementation((cmd: string) => {
          if (cmd === 'sc.exe stop kici-orchestrator') {
            throw scFailure(1061, 'The service cannot accept control messages at this time.');
          }
          if (cmd.includes('sc.exe query')) {
            const state = Date.now() - start >= 5_000 ? '1  STOPPED' : '3  STOP_PENDING';
            return Buffer.from(`        STATE              : ${state}\r\n`);
          }
          return Buffer.from('');
        });
        const { WindowsServiceManager } = await import('./windows.js');
        const restarting = new WindowsServiceManager().restart(testConfig);
        const assertion = expect(restarting).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(6_000);
        await assertion;
        expect(mockExecSync).toHaveBeenCalledWith('sc.exe start kici-orchestrator', {
          stdio: 'pipe',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('succeeds on 1061 when the stop in progress has finished by the time it checks', async () => {
      // fails-when: 1061 is accepted only while the query still reads
      // STOP_PENDING, so a stop that finished between the two calls fails.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'sc.exe stop kici-orchestrator') {
          throw scFailure(1061, 'The service cannot accept control messages at this time.');
        }
        if (cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 1  STOPPED\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      await expect(new WindowsServiceManager().stop(testConfig)).resolves.toBeUndefined();
    });

    it('rethrows 1061 for a service that is starting', async () => {
      // breaks-if-wrong: stop reports success for a service that goes on to run.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'sc.exe stop kici-orchestrator') {
          throw scFailure(1061, 'The service cannot accept control messages at this time.');
        }
        if (cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 2  START_PENDING\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await expect(mgr.stop(testConfig)).rejects.toThrow(/sc\.exe stop kici-orchestrator/);
    });

    it('surfaces any other sc.exe stop failure', async () => {
      // fails-when: every stop error is swallowed, as restart() and uninstall() do.
      // The query answers STOPPED, so only the error code keeps this failure visible.
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'sc.exe stop kici-orchestrator') {
          throw scFailure(5, 'Access is denied.');
        }
        if (cmd.includes('sc.exe query')) {
          return Buffer.from('        STATE              : 1  STOPPED\r\n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await expect(mgr.stop(testConfig)).rejects.toThrow(/sc\.exe stop kici-orchestrator/);

      mockExecSync.mockReset();
    });
  });

  describe('restart', () => {
    it('runs stop, polls until stopped, then start', async () => {
      // Mock sc.exe query to return STOPPED state (code 1) after stop
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          return Buffer.from(
            [
              'SERVICE_NAME: kici-orchestrator',
              '        STATE              : 1  STOPPED',
              '        PID                : 0',
            ].join('\r\n'),
          );
        }
        return undefined;
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.restart(testConfig);

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      const stopIdx = calls.indexOf('sc.exe stop kici-orchestrator');
      const queryIdx = calls.findIndex(
        (c: string) => typeof c === 'string' && c.includes('sc.exe query'),
      );
      const startIdx = calls.indexOf('sc.exe start kici-orchestrator');
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(queryIdx).toBeGreaterThan(stopIdx);
      expect(startIdx).toBeGreaterThan(queryIdx);

      mockExecSync.mockReset();
    });
  });

  describe('status', () => {
    it('parses RUNNING state', async () => {
      mockExecSync.mockReturnValueOnce(
        Buffer.from(
          [
            'SERVICE_NAME: kici-orchestrator',
            '        TYPE               : 10  WIN32_OWN_PROCESS',
            '        STATE              : 4  RUNNING',
            '        WIN32_EXIT_CODE    : 0  (0x0)',
            '        SERVICE_EXIT_CODE  : 0  (0x0)',
            '        CHECKPOINT         : 0x0',
            '        WAIT_HINT          : 0x0',
            '        PID                : 1234',
          ].join('\r\n'),
        ),
      );

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const s = await mgr.status(testConfig);

      expect(s.state).toBe('running');
      expect(s.pid).toBe(1234);
    });

    it('parses STOPPED state', async () => {
      mockExecSync.mockReturnValueOnce(
        Buffer.from(
          [
            'SERVICE_NAME: kici-orchestrator',
            '        STATE              : 1  STOPPED',
            '        PID                : 0',
          ].join('\r\n'),
        ),
      );

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const s = await mgr.status(testConfig);

      expect(s.state).toBe('stopped');
    });

    it('returns unknown on query failure', async () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('service not found');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const s = await mgr.status(testConfig);

      expect(s.state).toBe('unknown');
    });
  });

  describe('uninstall', () => {
    it('stops and deletes the service', async () => {
      // After sc.exe delete, the poll loop calls sc.exe query to confirm
      // the service is gone. Make query throw to simulate successful deletion.
      let deleteSeen = false;
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('sc.exe delete')) {
          deleteSeen = true;
        }
        if (deleteSeen && typeof cmd === 'string' && cmd.includes('sc.exe query')) {
          throw new Error('service not found');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.uninstall(testConfig);

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContain('sc.exe stop kici-orchestrator');
      expect(calls).toContain('sc.exe delete kici-orchestrator');
    });

    it('lets a slow shutdown finish before the service is removed', async () => {
      // The orchestrator takes 40s to stop, within its 45s grace; the SCM
      // removes a deleted service once its process has exited.
      // fails-when: uninstall deletes after a fixed 3s and gives up 30s later,
      // while the process is still shutting down.
      vi.useFakeTimers();
      try {
        const start = Date.now();
        let deleted = false;
        mockExecSync.mockImplementation((cmd: string) => {
          const stopped = Date.now() - start >= 40_000;
          if (cmd.includes('sc.exe delete')) deleted = true;
          if (cmd.includes('sc.exe query')) {
            if (deleted && stopped) throw new Error('service does not exist');
            const state = stopped ? '1  STOPPED' : '3  STOP_PENDING';
            return Buffer.from(`        STATE              : ${state}\r\n`);
          }
          return Buffer.from('');
        });
        const { WindowsServiceManager } = await import('./windows.js');
        const uninstalling = new WindowsServiceManager().uninstall({
          ...testConfig,
          component: 'orchestrator',
        });
        const assertion = expect(uninstalling).resolves.toBeUndefined();
        await vi.advanceTimersByTimeAsync(45_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('isInstalled', () => {
    it('returns true when sc.exe query succeeds', async () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('STATE: 4 RUNNING'));

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      expect(await mgr.isInstalled(testConfig)).toBe(true);
    });

    it('returns false when sc.exe query fails', async () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not found');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      expect(await mgr.isInstalled(testConfig)).toBe(false);
    });
  });

  describe('logs', () => {
    it('runs wevtutil for event log query', async () => {
      mockExecSync.mockReturnValueOnce(Buffer.from('Event log entries'));

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.logs(testConfig, {});

      const wevtCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('wevtutil'),
      );
      expect(wevtCall).toBeDefined();
    });
  });

  describe('component marker + list()', () => {
    it('prefixes the description with [KiCI:<component>] when component is set', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({ ...testConfig, component: 'orchestrator' });

      // Find the sc.exe description call carrying the marker prefix.
      const descCall = mockExecSync.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).includes('sc.exe description') &&
          (c[0] as string).includes('[KiCI:orchestrator]'),
      );
      expect(descCall).toBeDefined();
    });

    it('does NOT include [KiCI: prefix when component is unset', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install(testConfig);

      // No call should carry the [KiCI: marker when component is unset.
      const markerCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('[KiCI:'),
      );
      expect(markerCall).toBeUndefined();
    });

    it('appends a [KiCI-DIR:<path>] marker to the description when instanceDir is set', async () => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({ ...testConfig, component: 'orchestrator', instanceDir: 'C:\\kici\\dep' });

      const descCall = mockExecSync.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === 'string' &&
          (c[0] as string).includes('sc.exe description') &&
          (c[0] as string).includes('[KiCI-DIR:C:\\kici\\dep]'),
      );
      expect(descCall).toBeDefined();
    });

    it('recovers instanceDir from the [KiCI-DIR:<path>] description marker', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          return Buffer.from(
            JSON.stringify([
              {
                Name: 'kici-foo',
                Description: '[KiCI:orchestrator] KiCI orchestrator [KiCI-DIR:C:\\kici\\foo]',
              },
            ]),
          );
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const out = await mgr.list(false);

      expect(out).toEqual([
        {
          name: 'kici-foo',
          platform: 'windows',
          isUserLevel: false,
          component: 'orchestrator',
          instanceDir: 'C:\\kici\\foo',
        },
      ]);
    });

    it('list() returns discovered KiCI services with valid markers and skips unmarked ones', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          return Buffer.from(
            JSON.stringify([
              { Name: 'kici-foo', Description: '[KiCI:agent] some text' },
              { Name: 'kici-bar', Description: 'no marker here' },
            ]),
          );
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const out = await mgr.list(false);

      expect(out).toEqual([
        {
          name: 'kici-foo',
          platform: 'windows',
          isUserLevel: false,
          component: 'agent',
        },
      ]);
      expect(out.find((i) => i.name === 'kici-bar')).toBeUndefined();

      mockExecSync.mockReset();
    });

    // A failed WMI read must NOT read as an empty registry: `listInstances`
    // prunes this platform's index rows on an empty scan, so a `[]` here
    // deletes every windows install on the host the first time WMI hiccups.
    //
    // fails-when: the catch returns `[]` — `rejects.toThrow` fails outright.
    it('list() throws when Get-CimInstance fails, rather than reporting an empty registry', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          throw new Error('powershell unavailable');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();

      await expect(mgr.list(false)).rejects.toThrow(/could not read the Windows service registry/);
      await expect(mgr.list(false)).rejects.toThrow(/powershell unavailable/);

      mockExecSync.mockReset();
    });

    // fails-when: the JSON catch returns `[]` — same prune, reached by a
    // half-written or truncated PowerShell payload instead of a failed exit.
    it('list() throws on an unparseable payload, rather than reporting an empty registry', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          return Buffer.from('{ "Name": "kici-foo", ');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();

      await expect(mgr.list(false)).rejects.toThrow(/unparseable output/);

      mockExecSync.mockReset();
    });

    // breaks-if-wrong: the one honest `[]`. `ConvertTo-Json` emits nothing when
    // the query matches no service, so a blank answer means the registry DID
    // answer and holds no KiCI services — the reconcile must still prune on it.
    //
    // fails-when: the blank-output branch is folded into the throw above.
    it('list() returns [] on a blank answer, which is the registry answering', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          return Buffer.from('   \n');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();

      await expect(mgr.list(false)).resolves.toEqual([]);

      mockExecSync.mockReset();
    });

    // The scan is on the discovery path, so it must fail in seconds rather than
    // hang every `kici-admin` command behind an unresponsive WMI.
    //
    // fails-when: the `timeout` / `killSignal` options are dropped from the
    // `Get-CimInstance` call — both assertions on the options object fail.
    it('list() bounds its registry read with a timeout and a SIGKILL', async () => {
      let opts: { timeout?: number; killSignal?: string } | undefined;
      mockExecSync.mockImplementation((cmd: string, options: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          opts = options as { timeout?: number; killSignal?: string };
          return Buffer.from('');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      await new WindowsServiceManager().list(false);

      expect(opts?.timeout).toBe(10_000);
      expect(opts?.killSignal).toBe('SIGKILL');

      mockExecSync.mockReset();
    });

    it('list() decodes a single-object JSON payload (PowerShell single-row form)', async () => {
      // PowerShell's ConvertTo-Json emits a bare object (not a single-element array)
      // when only one row matches. The driver must wrap it in [] before iterating.
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          return Buffer.from(
            JSON.stringify({
              Name: 'kici-only',
              Description: '[KiCI:orchestrator] solo entry',
            }),
          );
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const out = await mgr.list(false);

      expect(out).toEqual([
        {
          name: 'kici-only',
          platform: 'windows',
          isUserLevel: false,
          component: 'orchestrator',
        },
      ]);

      mockExecSync.mockReset();
    });
  });

  describe('available()', () => {
    // fails-when: `available()` is absent, or probes only for the presence of
    // `powershell` — a client-only probe answers true on a host whose registry
    // is down, which is the shape that scanned empty and pruned live rows.
    it('reports false when the service registry does not answer', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          throw new Error('WMI: the RPC server is unavailable');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      await expect(new WindowsServiceManager().available()).resolves.toBe(false);

      mockExecSync.mockReset();
    });

    // breaks-if-wrong: a healthy host must report true, or the windows driver
    // is dropped from every scan and no instance is ever listed.
    it('reports true when the registry answers with an empty result set', async () => {
      mockExecSync.mockImplementation(() => Buffer.from(''));

      const { WindowsServiceManager } = await import('./windows.js');
      await expect(new WindowsServiceManager().available()).resolves.toBe(true);

      mockExecSync.mockReset();
    });

    // fails-when: the probe filters on a name that could match, or parses a
    // display string — either reintroduces an assumption about what is
    // installed or about the host's locale. It must also be bounded, for the
    // same reason `list()` is.
    it('probes the registry itself, with a filter that cannot match, under a timeout', async () => {
      let cmd = '';
      let opts: { timeout?: number; killSignal?: string } | undefined;
      mockExecSync.mockImplementation((c: string, options: unknown) => {
        cmd = c;
        opts = options as { timeout?: number; killSignal?: string };
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      await new WindowsServiceManager().available();

      expect(cmd).toContain('Get-CimInstance Win32_Service');
      expect(cmd).toContain('kici-availability-probe-no-such-service');
      expect(opts?.timeout).toBe(10_000);
      expect(opts?.killSignal).toBe('SIGKILL');

      mockExecSync.mockReset();
    });
  });

  describe('readLaunchSpec', () => {
    it('parses the shawl binPath after the -- separator', async () => {
      mockExecSync.mockReturnValueOnce(
        Buffer.from(
          'SERVICE_NAME: kici-orchestrator\n' +
            '        BINARY_PATH_NAME   : "C:\\shawl.exe" run --name "kici-orchestrator" -- ' +
            '"C:\\node\\node.exe" "C:\\Program Files\\KiCI\\@kici-dev\\orchestrator\\dist\\server.js"\n',
        ),
      );
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const spec = await mgr.readLaunchSpec(testConfig);
      expect(spec).toEqual({
        execPath: 'C:\\node\\node.exe',
        args: ['C:\\Program Files\\KiCI\\@kici-dev\\orchestrator\\dist\\server.js'],
      });
    });

    it('reads the batch-file launcher out of the cmd.exe wrapper', async () => {
      // fails-when: the spec reports cmd.exe as the launch target, so an
      // npm-source upgrade reads cmd.exe's version instead of the launcher's.
      mockExecSync.mockReturnValueOnce(
        Buffer.from(
          'SERVICE_NAME: kici-orchestrator\n' +
            '        BINARY_PATH_NAME   : C:\\shawl.exe run --name kici-orchestrator ' +
            '--stop-timeout 45000 -- C:\\Windows\\System32\\cmd.exe /d /e:on /v:off /c call ' +
            '"C:\\Program Files\\KiCI\\orch\\kici-orchestrator-standalone.cmd" <NUL\n',
        ),
      );
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      expect(await mgr.readLaunchSpec(testConfig)).toEqual({
        execPath: 'C:\\Program Files\\KiCI\\orch\\kici-orchestrator-standalone.cmd',
        args: [],
      });
    });

    /** The PowerShell read of a service's ImagePath, in UTF-8. */
    const IMAGE_PATH_READ =
      'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; (Get-ItemProperty -LiteralPath \'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\kici-orchestrator\').ImagePath"';

    /** sc.exe answers with `qc`; the ImagePath read answers with `image`. */
    function serveRegistration(qc: () => Buffer, image: string): void {
      mockExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).startsWith('sc.exe qc')) return qc();
        if (String(cmd).startsWith('powershell')) {
          expect(String(cmd)).toBe(IMAGE_PATH_READ);
          return Buffer.from(`\uFEFF${image}\r\n`, 'utf-8');
        }
        return '';
      });
    }

    // fails-when: readLaunchSpec gives up when sc.exe qc refuses a long command
    // line, so an npm-source upgrade cannot register such a service again.
    it('reads a command line too long for sc.exe qc from the registry', async () => {
      const entry = 'C:\\x\\@kici-dev\\orchestrator\\dist\\server.js';
      const value = 'v'.repeat(4200);
      serveRegistration(
        () => {
          throw Object.assign(new Error('[SC] QueryServiceConfig FAILED 1734'), { status: 1734 });
        },
        `"C:\\shawl.exe" run --name "kici-orchestrator" --env "A=${value}" -- ` +
          `"C:\\node\\node.exe" "${entry}"`,
      );
      const { WindowsServiceManager } = await import('./windows.js');
      expect(await new WindowsServiceManager().readLaunchSpec(testConfig)).toEqual({
        execPath: 'C:\\node\\node.exe',
        args: [entry],
      });
    });

    // fails-when: sc.exe's output, in the console code page, is decoded as
    // UTF-8, so a path under a profile such as C:\Users\Jürgen comes back with
    // U+FFFD and an upgrade would register a file that does not exist.
    it('reads a command line sc.exe cannot print in UTF-8 from the registry', async () => {
      const entry = 'C:\\Users\\J\u00fcrgen\\npm\\node_modules\\@kici-dev\\agent\\dist\\server.js';
      serveRegistration(
        () =>
          Buffer.from(
            `        BINARY_PATH_NAME   : "C:\\shawl.exe" run -- "C:\\node\\node.exe" "${entry.replace('\u00fc', '\uFFFD')}"\r\n`,
          ),
        `"C:\\shawl.exe" run -- "C:\\node\\node.exe" "${entry}"`,
      );
      const { WindowsServiceManager } = await import('./windows.js');
      expect(await new WindowsServiceManager().readLaunchSpec(testConfig)).toEqual({
        execPath: 'C:\\node\\node.exe',
        args: [entry],
      });
    });

    // fails-when: the command is split at the first " -- " anywhere in the line,
    // so a quoted value holding it (an older CLI's inline --env, a --cwd path)
    // becomes the launch command an upgrade registers.
    it('splits at the separator shawl reads, not at a " -- " inside a quoted value', async () => {
      mockExecSync.mockReturnValueOnce(
        Buffer.from(
          '        BINARY_PATH_NAME   : "C:\\shawl.exe" run --name "kici-orchestrator" ' +
            '--cwd "C:\\a -- b" --env "NOTE=x -- y" -- "C:\\node\\node.exe" "C:\\x\\server.js"\r\n',
        ),
      );
      const { WindowsServiceManager } = await import('./windows.js');
      expect(await new WindowsServiceManager().readLaunchSpec(testConfig)).toEqual({
        execPath: 'C:\\node\\node.exe',
        args: ['C:\\x\\server.js'],
      });
    });

    it('returns null when there is no -- separator', async () => {
      mockExecSync.mockReturnValueOnce(
        Buffer.from('BINARY_PATH_NAME   : "C:\\\\custom\\\\opaque.exe"\n'),
      );
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      expect(await mgr.readLaunchSpec(testConfig)).toBeNull();
    });

    it('returns null when sc.exe qc fails', async () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('service not found');
      });
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      expect(await mgr.readLaunchSpec(testConfig)).toBeNull();
    });
  });

  describe('registering again from the read-back launch command', () => {
    /** The shawl `add` command install() ran, from its ` -- ` separator on. */
    function shawlTail(): string {
      const call = mockExecSync.mock.calls.find(
        (c: unknown[]) => String(c[0]).includes('shawl') && String(c[0]).includes(' add '),
      );
      const cmd = String(call![0]);
      return cmd.slice(cmd.indexOf(' -- ') + 4);
    }

    // An npm-source upgrade registers the service again from the command
    // readLaunchSpec returns, so that command must round-trip.
    it.each([
      [
        'a node entry',
        {
          executablePath: 'C:\\Program Files\\nodejs\\node.exe',
          args: [
            'C:\\npm\\node_modules\\kici-admin\\node_modules\\@kici-dev\\agent\\dist\\server.js',
          ],
        },
      ],
      [
        'a batch-file launcher',
        { executablePath: 'C:\\Program Files\\KiCI\\a\\kici-agent.cmd', args: [] },
      ],
    ])('reproduces the command install registered, for %s', async (_label, launch) => {
      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      await mgr.install({ ...testConfig, ...launch });
      const first = shawlTail();

      // shawl stores the command after its own `run` arguments.
      mockExecSync.mockImplementation((cmd: unknown) => {
        if (String(cmd).startsWith('sc.exe qc')) {
          return Buffer.from(
            `        BINARY_PATH_NAME   : "C:\\cache\\shawl.exe" run --name "kici-orchestrator" -- ${first}\r\n`,
          );
        }
        if (String(cmd).includes('sc.exe query')) throw new Error('service does not exist');
        return '';
      });
      const spec = await mgr.readLaunchSpec(testConfig);
      mockExecSync.mockClear();
      await mgr.install({ ...testConfig, executablePath: spec!.execPath, args: spec!.args });
      // fails-when: reading the command back drops the batch wrapper or an
      // argument, so an upgrade that registers the service again changes what it runs.
      expect(shawlTail()).toBe(first);
    });
  });
});
