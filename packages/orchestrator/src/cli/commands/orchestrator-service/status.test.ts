/**
 * Tests for the orchestrator status command's folder-anchored behavior:
 * refusal when no targeting flag and no CWD manifest, and --instance-dir
 * resolution flowing through to manager.status with a ServiceConfig built
 * from the manifest. The action also reads the env file for the port + calls
 * /health, but the default mock returns state: 'stopped' so the HTTP path
 * is skipped.
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
  ServiceStatus,
} from '../../service/types.js';

let mockListResult: DiscoveredInstance[] = [];
let mockStatusResult: ServiceStatus = { state: 'stopped' };
const mockStatus = vi.fn(async () => mockStatusResult);
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
      stop: vi.fn(),
      restart: vi.fn(),
      status: op(platform, (...args: unknown[]) =>
        mockStatus(...(args as Parameters<typeof mockStatus>)),
      ),
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

import { registerStatusCommand, formatConfigPaths } from './status.js';
import { writeIndex, writeManifest } from '../../service/index.js';
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

describe('orchestrator status — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-e4-st-i-');
    tmpConfigRoot = mkTmp('kici-e4-st-c-');

    mockListResult = [];
    mockStatusResult = { state: 'stopped' };
    mockStatus.mockClear();
    mockList.mockClear();
    operatedPlatforms.length = 0;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('orchestrator');
    registerStatusCommand(program);

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
    const emptyCwd = mkTmp('kici-e4-st-cwd-');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      process.chdir(emptyCwd);
      await expect(program.parseAsync(['node', 'orchestrator', 'status'])).rejects.toThrow(
        'process.exit called',
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errArgs).toContain('No orchestrator instances installed on this host');
      expect(mockStatus).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
      exitSpy.mockRestore();
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it('resolves via --instance-dir and calls manager.status', async () => {
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

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    const cfg = mockStatus.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-test');
    expect(cfg.component).toBe('orchestrator');
    expect(cfg.envFilePath).toBe(manifest.envFilePath);
    expect(cfg.workingDirectory).toBe(manifest.configDir);
    expect(cfg.isUserLevel).toBe(true);
  });

  it('prints the config paths in both outputs for a stopped service', async () => {
    // fails-when: the formatter is computed but never emitted, or is emitted
    // only while the service is running — this instance is stopped, which is
    // the case the command exists to answer.
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

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);
    const text = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(text).toContain('--- Config files ---');
    expect(text).toContain(`Env file:      ${manifest.envFilePath}`);

    consoleLogSpy.mockClear();
    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--json',
    ]);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({ envFile: manifest.envFilePath });
  });

  it('reports the compose file from the manifest, not from the host platform', async () => {
    // fails-when: the compose branch reads detectPlatform() instead of the
    // manifest. detectPlatform is mocked to 'systemd' here — the value it
    // returns on any systemd Linux, including a host whose orchestrator is a
    // compose install — while the manifest records the install's real shape.
    // Reading the host value drops the compose file for the common case.
    const manifest = makeManifest({ name: 'kici-test', platform: 'compose' });
    writeManifest(tmpInstanceDir, manifest);
    writeIndex(tmpConfigRoot, [
      {
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'compose',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--json',
    ]);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({
      envFile: '/x/kici-test.env',
      composeFile: '/x/kici-test-compose.yaml',
    });
  });

  it('reports paths for the driver --platform forced, not for the manifest', async () => {
    // `--platform` forces one driver for the whole command, so the status it
    // prints describes that driver's view. Re-deriving the platform from the
    // manifest instead makes the two disagree: a systemd driver reporting a
    // compose file for a stack it is not operating.
    //
    // fails-when: `installPlatform` is read off `resolved.manifest.platform`
    // again — `composeFile` reappears here while `manager` is the systemd one.
    const manifest = makeManifest({ name: 'kici-test', platform: 'compose' });
    writeManifest(tmpInstanceDir, manifest);

    await program.parseAsync([
      'node',
      'orchestrator',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--platform',
      'systemd',
      '--json',
    ]);

    expect([...new Set(operatedPlatforms)]).toEqual(['systemd']);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({ envFile: '/x/kici-test.env' });
  });

  it('omits the compose file for a bare-metal install', async () => {
    // breaks-if-wrong: the counterpart of the case above. A systemd install must
    // never be handed a compose file it does not have. The manifest is the only
    // input either case reads, so this one cannot itself separate host from
    // manifest — the compose case above is what pins that axis.
    const manifest = makeManifest({ name: 'kici-test', platform: 'systemd' });
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
      'status',
      '--instance-dir',
      tmpInstanceDir,
      '--json',
    ]);
    const json = JSON.parse(String(consoleLogSpy.mock.calls[0]![0])) as {
      configPaths: Record<string, string>;
    };
    expect(json.configPaths).toEqual({ envFile: '/x/kici-test.env' });
  });

  // fails-when: the action picks the manager from the host. detectPlatform is
  // pinned to 'systemd' by the module mock, so a host-derived selection operates
  // the systemd driver and operatedPlatforms holds 'systemd'.
  it('operates a compose-manifest install through the compose driver on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', platform: 'compose' }));

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect([...new Set(operatedPlatforms)]).toEqual(['compose']);
  });

  // breaks-if-wrong: the overwhelmingly common case must be unaffected — a
  // systemd install on a systemd host still operates through the systemd driver.
  it('operates a systemd-manifest install through the systemd driver', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', platform: 'systemd' }));

    await program.parseAsync(['node', 'orchestrator', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect([...new Set(operatedPlatforms)]).toEqual(['systemd']);
  });
});

describe('formatConfigPaths', () => {
  it('lists the env file for a bare-metal install', () => {
    // fails-when: the env file line is dropped or relabelled — the array no
    // longer equals this literal.
    expect(
      formatConfigPaths({
        platform: 'systemd',
        serviceName: 'orch1',
        envFilePath: '/etc/kici/orch1.env',
        envContent: '',
      }),
    ).toEqual(['--- Config files ---', 'Env file:      /etc/kici/orch1.env']);
  });

  it('adds the compose file only for a compose install', () => {
    // fails-when: the compose line is emitted unconditionally — a systemd
    // operator would be sent to a file that does not exist. The systemd case
    // above pins that with an exact-array assertion.
    const compose = formatConfigPaths({
      platform: 'compose',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
      envContent: '',
    });
    expect(compose).toContain('Compose file:  /etc/kici/orch1-compose.yaml');
  });

  it('adds the scaler config when the env file names one', () => {
    // fails-when: the scaler lookup reads a different key, or the env file is
    // not consulted at all — the line is absent.
    const lines = formatConfigPaths({
      platform: 'systemd',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
      envContent: 'KICI_SCALER_CONFIG_PATH=/etc/kici/scalers.yaml\n',
    });
    expect(lines).toContain('Scaler config: /etc/kici/scalers.yaml');
  });

  it('falls back to the scaler config directory', () => {
    // fails-when: only KICI_SCALER_CONFIG_PATH is consulted — a directory-based
    // install reports no scaler config at all.
    const lines = formatConfigPaths({
      platform: 'systemd',
      serviceName: 'orch1',
      envFilePath: '/etc/kici/orch1.env',
      envContent: 'KICI_SCALER_CONFIG_DIR=/etc/kici/scalers.d\n',
    });
    expect(lines).toContain('Scaler config: /etc/kici/scalers.d');
  });
});
