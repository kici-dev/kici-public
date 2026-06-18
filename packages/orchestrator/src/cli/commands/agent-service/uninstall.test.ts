/**
 * Tests for the agent uninstall command's folder-anchored behavior:
 * refusal when no targeting flag and no CWD manifest, and --instance-dir
 * resolution flowing through to manager.uninstall + index removal with a
 * ServiceConfig built from the manifest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredInstance, ServiceConfig, ServiceStatus } from '../../service/types.js';

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

import { registerAgentUninstall } from './uninstall.js';
import { readIndex, writeIndex, writeManifest } from '../../service/index.js';
import type { InstanceManifest } from '../../service/index.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeManifest(overrides: Partial<InstanceManifest> = {}): InstanceManifest {
  return {
    component: 'agent',
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

describe('agent uninstall — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-f2-i-');
    tmpConfigRoot = mkTmp('kici-f2-c-');

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
    program.name('agent');
    registerAgentUninstall(program);

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
        component: 'agent',
      },
    ];
    writeIndex(tmpConfigRoot, [
      {
        component: 'agent',
        name: 'kici-existing',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: '/some/place',
      },
    ]);

    const savedCwd = process.cwd();
    const emptyCwd = mkTmp('kici-f2-cwd-');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      process.chdir(emptyCwd);
      await expect(program.parseAsync(['node', 'agent', 'uninstall'])).rejects.toThrow(
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
        component: 'agent',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync(['node', 'agent', 'uninstall', '--instance-dir', tmpInstanceDir]);

    expect(mockUninstall).toHaveBeenCalledTimes(1);
    const cfg = mockUninstall.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-test');
    expect(cfg.component).toBe('agent');
    expect(cfg.envFilePath).toBe(manifest.envFilePath);
    expect(cfg.workingDirectory).toBe(manifest.configDir);

    // Index entry removed.
    expect(readIndex(tmpConfigRoot)).toEqual([]);
  });
});
