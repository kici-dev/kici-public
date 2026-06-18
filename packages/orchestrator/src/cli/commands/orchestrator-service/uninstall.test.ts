/**
 * Tests for the orchestrator uninstall command's folder-anchored behavior:
 * refusal when no targeting flag and no CWD manifest, --instance-dir / --name
 * / CWD-manifest resolution, manager.uninstall + index-removal call shape,
 * and the orphan-self-heal path where the unit is already gone but the index
 * row still needs to disappear.
 *
 * Same partial-mock strategy as install.test.ts — stub only the platform-
 * touching surface of service/index.js (createServiceManager, detectPlatform,
 * resolveUserLevel, kiciConfigRoot) and re-export the real instance helpers
 * (resolveInstance, removeIndexEntry, readIndex, writeIndex, writeManifest).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredInstance, ServiceConfig, ServiceStatus } from '../../service/types.js';

// Per-test mock state. Reassigned in beforeEach so each test gets its own
// tmpdirs + a clean manager stub.
let mockListResult: DiscoveredInstance[] = [];
let mockIsInstalled = true;
let mockStatusResult: ServiceStatus = { state: 'stopped' };
const mockUninstall = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockStatus = vi.fn(async () => mockStatusResult);
const mockIsInstalledFn = vi.fn(async () => mockIsInstalled);
const mockList = vi.fn(async (_isUserLevel: boolean) => mockListResult);
let mockKiciRoot = '';

vi.mock('../../service/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../service/index.js')>('../../service/index.js');
  return {
    ...actual,
    detectPlatform: vi.fn().mockReturnValue('systemd'),
    resolveUserLevel: vi.fn().mockReturnValue(true),
    kiciConfigRoot: vi.fn(() => mockKiciRoot),
    createServiceManager: vi.fn().mockResolvedValue({
      install: vi.fn(),
      uninstall: (...args: unknown[]) => mockUninstall(...args),
      start: vi.fn(),
      stop: (...args: unknown[]) => mockStop(...args),
      restart: vi.fn(),
      status: (...args: unknown[]) => mockStatus(...(args as Parameters<typeof mockStatus>)),
      logs: vi.fn(),
      isInstalled: (...args: unknown[]) =>
        mockIsInstalledFn(...(args as Parameters<typeof mockIsInstalledFn>)),
      list: (...args: unknown[]) => mockList(...(args as Parameters<typeof mockList>)),
    }),
  };
});

// Import after mocks so the action picks up the mocked module.
import { registerOrchestratorUninstall } from './uninstall.js';
import { readIndex, writeIndex, writeManifest } from '../../service/index.js';
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

describe('orchestrator uninstall — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-e2-i-');
    tmpConfigRoot = mkTmp('kici-e2-c-');

    mockListResult = [];
    mockIsInstalled = true;
    mockStatusResult = { state: 'stopped' };
    mockUninstall.mockClear();
    mockStop.mockClear();
    mockStatus.mockClear();
    mockIsInstalledFn.mockClear();
    mockList.mockClear();
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('orchestrator');
    registerOrchestratorUninstall(program);

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

  it('refuses with candidate list when no flag and no CWD manifest', async () => {
    mockListResult = [
      {
        name: 'kici-existing',
        platform: 'systemd',
        isUserLevel: true,
        component: 'orchestrator',
      },
    ];
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-existing',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: '/some/place',
      },
    ]);

    const savedCwd = process.cwd();
    const emptyCwd = mkTmp('kici-e2-cwd-');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      process.chdir(emptyCwd);
      await expect(program.parseAsync(['node', 'orchestrator', 'uninstall'])).rejects.toThrow(
        'process.exit called',
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errArgs).toContain('No instance specified');
      expect(errArgs).toContain('kici-existing');
      expect(mockUninstall).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
      exitSpy.mockRestore();
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it('resolves via --instance-dir, calls manager.uninstall, removes index entry', async () => {
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

    await program.parseAsync([
      'node',
      'orchestrator',
      'uninstall',
      '--instance-dir',
      tmpInstanceDir,
    ]);

    expect(mockUninstall).toHaveBeenCalledTimes(1);
    const cfg = mockUninstall.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-test');
    expect(cfg.component).toBe('orchestrator');
    expect(cfg.envFilePath).toBe(manifest.envFilePath);
    expect(cfg.workingDirectory).toBe(manifest.configDir);

    // Index entry removed.
    expect(readIndex(tmpConfigRoot)).toEqual([]);
  });

  it('resolves via --name, then performs uninstall + index removal', async () => {
    const manifest = makeManifest({ name: 'kici-foo' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-foo',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);
    mockListResult = [
      {
        name: 'kici-foo',
        platform: 'systemd',
        isUserLevel: true,
        component: 'orchestrator',
      },
    ];

    await program.parseAsync(['node', 'orchestrator', 'uninstall', '--name', 'kici-foo']);

    expect(mockUninstall).toHaveBeenCalledTimes(1);
    const cfg = mockUninstall.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-foo');
    expect(readIndex(tmpConfigRoot)).toEqual([]);
  });

  it('resolves via CWD manifest, then performs uninstall + index removal', async () => {
    const manifest = makeManifest({ name: 'kici-cwd' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-cwd',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    const savedCwd = process.cwd();
    try {
      process.chdir(tmpInstanceDir);
      await program.parseAsync(['node', 'orchestrator', 'uninstall']);

      expect(mockUninstall).toHaveBeenCalledTimes(1);
      const cfg = mockUninstall.mock.calls[0]![0] as ServiceConfig;
      expect(cfg.name).toBe('kici-cwd');
      expect(readIndex(tmpConfigRoot)).toEqual([]);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('still drops the index entry when manager.isInstalled returns false', async () => {
    const manifest = makeManifest({ name: 'kici-orphan' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-orphan',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);
    mockIsInstalled = false;

    await program.parseAsync([
      'node',
      'orchestrator',
      'uninstall',
      '--instance-dir',
      tmpInstanceDir,
    ]);

    // Did NOT call manager.uninstall because nothing is installed.
    expect(mockUninstall).not.toHaveBeenCalled();
    // But the index row IS gone — orphan self-heal.
    expect(readIndex(tmpConfigRoot)).toEqual([]);
    // And the "not installed" line was printed.
    const logs = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('is not installed');
  });

  it('stops a running service before uninstalling', async () => {
    const manifest = makeManifest({ name: 'kici-running' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-running',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);
    mockStatusResult = { state: 'running', pid: 1234 };

    await program.parseAsync([
      'node',
      'orchestrator',
      'uninstall',
      '--instance-dir',
      tmpInstanceDir,
    ]);

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockUninstall).toHaveBeenCalledTimes(1);
    expect(readIndex(tmpConfigRoot)).toEqual([]);
  });
});
