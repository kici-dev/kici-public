/**
 * Tests for the Windows service manager.
 *
 * Mocks child_process.execSync and fs operations to test service
 * lifecycle commands via shawl + sc.exe without requiring Windows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServiceConfig } from './types.js';
import { DEFAULT_RESTART_POLICY } from './types.js';

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
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
      // Mock env file as existing so --env KEY=value pairs are included
      mockExistsSync.mockReturnValue(true);
      const mockReadFileSync = vi
        .fn()
        .mockReturnValue('DATABASE_URL=postgres://localhost\nPORT=8080\n');
      const fs = await import('node:fs');
      vi.spyOn(fs.default, 'readFileSync').mockImplementation(mockReadFileSync as never);

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
});
