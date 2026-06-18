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

    it('list() returns [] cleanly when Get-CimInstance fails', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('Get-CimInstance')) {
          throw new Error('powershell unavailable');
        }
        return Buffer.from('');
      });

      const { WindowsServiceManager } = await import('./windows.js');
      const mgr = new WindowsServiceManager();
      const out = await mgr.list(false);

      expect(out).toEqual([]);

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
