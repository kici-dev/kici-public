/**
 * Tests for the orchestrator stop command's folder-anchored behavior:
 * refusal when no targeting flag and no CWD manifest, and --instance-dir
 * resolution flowing through to manager.stop with a ServiceConfig built
 * from the manifest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredInstance,
  ServiceConfig,
  ServiceManager,
  ServicePlatform,
} from '../../service/types.js';

let mockListResult: DiscoveredInstance[] = [];
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn(async (_isUserLevel: boolean) => mockListResult);
let mockKiciRoot = '';

/** Platforms whose driver the command operated through — discovery `list` calls excluded. */
const operatedPlatforms: string[] = [];

/** Wrap a driver operation so it records which platform's driver ran it. */
function op<A extends unknown[], R>(platform: string, fn: (...a: A) => R): (...a: A) => R {
  return (...args: A) => {
    operatedPlatforms.push(platform);
    return fn(...args);
  };
}

vi.mock('../../service/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../service/index.js')>('../../service/index.js');

  const makeManager = (platform: ServicePlatform): ServiceManager =>
    ({
      platform,
      install: vi.fn(),
      uninstall: vi.fn(),
      start: vi.fn(),
      stop: op(platform, (...args: unknown[]) => mockStop(...args)),
      restart: vi.fn(),
      status: vi.fn(),
      logs: vi.fn(),
      isInstalled: vi.fn(),
      list: (...args: unknown[]) => mockList(...(args as Parameters<typeof mockList>)),
    }) as unknown as ServiceManager;
  return {
    ...actual,
    detectPlatform: vi.fn().mockReturnValue('systemd'),
    resolveUserLevel: vi.fn().mockReturnValue(true),
    kiciConfigRoot: vi.fn(() => mockKiciRoot),
    createServiceManager: vi.fn(async (platform: ServicePlatform) => makeManager(platform)),
    // Manager selection lives in the seam, so the real one runs here with the
    // driver factory injected: every candidate platform gets its own double, and
    // `op` records which one the command actually operated through.
    resolveInstanceTarget: (args: Parameters<typeof actual.resolveInstanceTarget>[0]) =>
      actual.resolveInstanceTarget({ ...args, createManager: async (p) => makeManager(p) }),
  };
});

import { registerOrchestratorStop } from './stop.js';
import { InstanceNotFoundError, writeIndex, writeManifest } from '../../service/index.js';
import type { InstanceManifest } from '../../service/index.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    component: 'orchestrator',
    name: 'kici-test',
    platform: 'systemd',
    isUserLevel: true,
    envFilePath: '/x/kici-test.env',
    configDir: '/x/',
    logDir: '/x/logs/',
    installBase: '/opt/kici/kici-test/',
    createdAt: '2026-05-28T00:00:00Z',
    kiciVersion: '0.1.13',
    ...overrides,
  };
}

describe('orchestrator stop — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-e4-stop-i-');
    tmpConfigRoot = mkTmp('kici-e4-stop-c-');

    mockListResult = [];
    mockStop.mockClear();
    mockList.mockClear();
    operatedPlatforms.length = 0;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('orchestrator');
    registerOrchestratorStop(program);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const dir of [tmpInstanceDir, tmpConfigRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses without --instance-dir/--name and no CWD manifest', async () => {
    const savedCwd = process.cwd();
    const emptyCwd = mkTmp('kici-e4-stop-cwd-');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      process.chdir(emptyCwd);
      await expect(program.parseAsync(['node', 'orchestrator', 'stop'])).rejects.toThrow(
        'process.exit called',
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errArgs).toContain('No orchestrator instances installed on this host');
      expect(mockStop).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
      exitSpy.mockRestore();
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it('exits 0 as a no-op when --name matches no installed instance', async () => {
    // Empty scan → resolveInstance throws InstanceNotFoundError for the name.
    mockListResult = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await program.parseAsync(['node', 'orchestrator', 'stop', '--name', 'kici-absent']);
      // Did NOT stop anything and did NOT exit non-zero.
      expect(mockStop).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('not installed');
      // Sanity: the typed error the handler branches on is a real Error subclass.
      expect(new InstanceNotFoundError('orchestrator', 'x', 'm')).toBeInstanceOf(Error);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('resolves via --instance-dir and calls manager.stop', async () => {
    const manifest = makeManifest({ name: 'kici-test' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync(['node', 'orchestrator', 'stop', '--instance-dir', tmpInstanceDir]);

    expect(mockStop).toHaveBeenCalledTimes(1);
    const cfg = mockStop.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-test');
    expect(cfg.component).toBe('orchestrator');
    expect(cfg.envFilePath).toBe(manifest.envFilePath);
    expect(cfg.workingDirectory).toBe(manifest.configDir);
    expect(cfg.isUserLevel).toBe(true);
  });

  // fails-when: the action picks the manager from the host. detectPlatform is
  // pinned to 'systemd' by the module mock, so a host-derived selection operates
  // the systemd driver and operatedPlatforms holds 'systemd'.
  it('operates a compose-manifest install through the compose driver on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', platform: 'compose' }));

    await program.parseAsync(['node', 'orchestrator', 'stop', '--instance-dir', tmpInstanceDir]);

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect([...new Set(operatedPlatforms)]).toEqual(['compose']);
  });

  // breaks-if-wrong: the overwhelmingly common case must be unaffected — a
  // systemd install on a systemd host still operates through the systemd driver.
  it('operates a systemd-manifest install through the systemd driver', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', platform: 'systemd' }));

    await program.parseAsync(['node', 'orchestrator', 'stop', '--instance-dir', tmpInstanceDir]);

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect([...new Set(operatedPlatforms)]).toEqual(['systemd']);
  });
});
