/**
 * Tests for the agent status command's folder-anchored behavior:
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

import { registerAgentStatusCommand } from './status.js';
import { writeIndex, writeManifest } from '../../service/index.js';
import type { InstanceManifest } from '../../service/index.js';
import type { AgentLivenessInfo, LivenessResponse } from '@kici-dev/shared';

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

describe('agent status — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-f-st-i-');
    tmpConfigRoot = mkTmp('kici-f-st-c-');

    mockListResult = [];
    mockStatusResult = { state: 'stopped' };
    mockStatus.mockClear();
    mockList.mockClear();
    operatedPlatforms.length = 0;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('agent');
    registerAgentStatusCommand(program);

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
    const emptyCwd = mkTmp('kici-f-st-cwd-');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      process.chdir(emptyCwd);
      await expect(program.parseAsync(['node', 'agent', 'status'])).rejects.toThrow(
        'process.exit called',
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errArgs).toContain('No agent instances installed on this host');
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
        component: 'agent',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        instanceDir: tmpInstanceDir,
      },
    ]);

    await program.parseAsync(['node', 'agent', 'status', '--instance-dir', tmpInstanceDir]);

    expect(mockStatus).toHaveBeenCalledTimes(1);
    const cfg = mockStatus.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.name).toBe('kici-test');
    expect(cfg.component).toBe('agent');
    expect(cfg.envFilePath).toBe(manifest.envFilePath);
    expect(cfg.workingDirectory).toBe(manifest.configDir);
    expect(cfg.isUserLevel).toBe(true);
  });

  // fails-when: the action picks the manager from the host. detectPlatform is
  // pinned to 'systemd' by the module mock, so a host-derived selection operates
  // the systemd driver and operatedPlatforms reads ['systemd'].
  it('operates a compose-manifest install through the compose driver on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ platform: 'compose' }));

    await program.parseAsync(['node', 'agent', 'status', '--instance-dir', tmpInstanceDir]);

    expect(operatedPlatforms).toEqual(['compose']);
    expect(mockStatus).toHaveBeenCalledTimes(1);
  });

  // breaks-if-wrong: the overwhelmingly common case must be unaffected — a
  // systemd install on a systemd host still operates through the systemd driver.
  it('operates a systemd-manifest install through the systemd driver', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ platform: 'systemd' }));

    await program.parseAsync(['node', 'agent', 'status', '--instance-dir', tmpInstanceDir]);

    expect(operatedPlatforms).toEqual(['systemd']);
    expect(mockStatus).toHaveBeenCalledTimes(1);
  });
});

/**
 * A /health body in the agent's declared shape. The type is the one the agent's
 * health route is annotated with, so a field renamed or dropped on the agent side
 * stops this fixture compiling.
 */
function agentHealthBody(
  overrides: Partial<LivenessResponse<AgentLivenessInfo>> = {},
): LivenessResponse<AgentLivenessInfo> {
  return {
    status: 'ok',
    timestamp: '2026-09-26T04:00:00.000Z',
    uptime: 226.556527459,
    agentId: 'agent-7f3a',
    connected: true,
    activeJobs: 2,
    version: '9.8.7',
    buildCommit: 'c0ffee123',
    sdkVersion: '9.8.6',
    sdkBundleHash: 'b012bd8bace3df9e574252bf290c652b',
    sharedVersion: '9.8.5',
    sharedBundleHash: 'c43dafa78ecdfdff530b94f7f0629d29',
    engineVersion: '9.8.4',
    engineBundleHash: '0253acfa2150e263bde9698a0d8e9595',
    ...overrides,
  };
}

describe('agent status — health section', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let requestedUrls: string[];

  function serveHealth(body: LivenessResponse<AgentLivenessInfo>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }

  function installWithEnv(envContent: string): void {
    const envFilePath = path.join(tmpInstanceDir, 'agent.env');
    fs.writeFileSync(envFilePath, envContent);
    writeManifest(tmpInstanceDir, makeManifest({ name: 'kici-test', envFilePath }));
  }

  async function runStatus(extraArgs: string[] = []): Promise<string> {
    await program.parseAsync([
      'node',
      'agent',
      'status',
      '--instance-dir',
      tmpInstanceDir,
      ...extraArgs,
    ]);
    return consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-ag-health-i-');
    tmpConfigRoot = mkTmp('kici-ag-health-c-');
    mockKiciRoot = tmpConfigRoot;
    mockStatusResult = { state: 'running', pid: 4343 };
    mockStatus.mockClear();
    requestedUrls = [];

    program = new Command();
    program.name('agent');
    registerAgentStatusCommand(program);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    mockStatusResult = { state: 'stopped' };
    for (const dir of [tmpInstanceDir, tmpConfigRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders the fields the agent reports on /health', async () => {
    // fails-when: the renderer reads fields the agent's /health does not send —
    // a Labels or Current job line appears, stating a value no agent reported.
    installWithEnv('KICI_PORT=5555\n');
    serveHealth(agentHealthBody());

    const text = await runStatus();
    const lines = text.split('\n');

    expect(requestedUrls).toEqual(['http://localhost:5555/health']);
    expect(lines).toContain('Agent ID:     agent-7f3a');
    expect(lines).toContain('Orchestrator: connected');
    expect(lines).toContain('Active jobs:  2');
    expect(lines).toContain('Version:      9.8.7');
    // fails-when: the renderer prints the build commit an agent older than this
    // CLI reports — a commit ID from the private repository.
    expect(text).not.toContain('c0ffee123');
    expect(lines).toContain('SDK:          9.8.6 (bundle b012bd8bace3)');
    expect(lines).toContain('Uptime:       3m 46s');
    expect(lines.some((l) => l.startsWith('Labels:'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Current job:'))).toBe(false);
  });

  it('reports a disconnected agent as disconnected', async () => {
    // breaks-if-wrong: the connection line follows the reported value in both
    // directions, not only the connected default.
    installWithEnv('KICI_PORT=5555\n');
    serveHealth(agentHealthBody({ connected: false, activeJobs: 0 }));

    const lines = (await runStatus()).split('\n');

    expect(lines).toContain('Orchestrator: disconnected');
    expect(lines).toContain('Active jobs:  0');
  });

  it("queries the agent's default port when the env file sets no KICI_PORT", async () => {
    // fails-when: the fallback is anything but the port the agent binds with
    // KICI_PORT unset (8080). `kici-admin agent install` writes no KICI_PORT,
    // so this env file is the default install's.
    installWithEnv('KICI_ORCHESTRATOR_URL=ws://localhost:4000/ws\n');
    serveHealth(agentHealthBody());

    await runStatus();

    expect(requestedUrls).toEqual(['http://localhost:8080/health']);
  });

  it('ignores KICI_AGENT_PORT, which the agent never reads', async () => {
    // fails-when: status honours a variable the agent does not, and queries a
    // port nothing listens on while the agent answers on its default.
    installWithEnv('KICI_AGENT_PORT=1234\n');
    serveHealth(agentHealthBody());

    await runStatus();

    expect(requestedUrls).toEqual(['http://localhost:8080/health']);
  });

  it('never prints the agent heading with nothing under it', async () => {
    // fails-when: a /health body carrying no field this CLI knows (another
    // service answering on the port) yields a bare heading.
    installWithEnv('KICI_PORT=5555\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    const lines = (await runStatus()).split('\n');
    const heading = lines.indexOf('--- KiCI agent ---');

    expect(heading).toBeGreaterThanOrEqual(0);
    expect(lines[heading + 1]).toMatch(/^Health: +\S/);
  });

  it('returns the /health body in --json, with the version in the deprecated buildCommit', async () => {
    // fails-when: --json passes through the build commit an older agent reports.
    // breaks-if-wrong: every other field of the body comes back unchanged.
    installWithEnv('KICI_PORT=5555\n');
    const body = agentHealthBody();
    serveHealth(body);

    const text = await runStatus(['--json']);
    const json = JSON.parse(text) as { health: unknown };

    expect(json.health).toEqual({ ...body, buildCommit: body.version });
    expect(text).not.toContain('c0ffee123');
  });
});
