/**
 * Tests for the agent install command's folder-anchored behavior:
 * --instance-dir handling, manifest write, index append, create-path guard,
 * and the component marker passed through to manager.install(). Wizard wiring
 * is also covered: the --wizard flag calls runAgentWizard() and generates the
 * expected env file content.
 *
 * The strategy: mock only the platform-touching surface of
 * `service/index.js` (createServiceManager, detectPlatform,
 * resolveUserLevel, getConfigDir, getLogDir, kiciConfigRoot), and re-export
 * the real instance helpers (listInstances, writeManifest, appendIndexEntry,
 * readIndex). The real helpers exercise real fs against per-test tmpdirs,
 * so the manifest write + index append paths are covered end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredInstance, ServiceConfig } from '../../service/types.js';

// Per-test mock state. Reassigned in beforeEach so each test gets its own
// tmpdirs + a clean manager stub.
let mockListResult: DiscoveredInstance[] = [];
const mockInstall = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn(async (_isUserLevel: boolean) => mockListResult);
let mockConfigDir = '';
let mockLogDir = '';
let mockKiciRoot = '';

vi.mock('../../service/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../service/index.js')>('../../service/index.js');
  return {
    ...actual,
    detectPlatform: vi.fn().mockReturnValue('systemd'),
    resolveUserLevel: vi.fn().mockReturnValue(true),
    getConfigDir: vi.fn(() => mockConfigDir),
    getLogDir: vi.fn(() => mockLogDir),
    kiciConfigRoot: vi.fn(() => mockKiciRoot),
    createServiceManager: vi.fn().mockResolvedValue({
      install: (...args: unknown[]) => mockInstall(...args),
      list: (...args: unknown[]) => mockList(...(args as Parameters<typeof mockList>)),
    }),
  };
});

// Mock the agent wizard module.
vi.mock('../../wizard/agent-wizard.js', () => ({
  runAgentWizard: vi.fn().mockResolvedValue({
    orchestratorUrl: 'http://orch.example.com:4000',
    agentToken: 'test-token-abc123',
    labels: ['linux', 'x64'],
  }),
}));

// Import after mocks so the action picks up the mocked module.
import { registerAgentInstall } from './install.js';
import { readIndex, manifestPath } from '../../service/index.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('agent install — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let tmpServiceConfigDir: string;
  let tmpLogDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-f1-i-');
    tmpConfigRoot = mkTmp('kici-f1-c-');
    tmpServiceConfigDir = path.join(tmpConfigRoot, 'kici-test') + path.sep;
    tmpLogDir = mkTmp('kici-f1-l-');

    mockListResult = [];
    mockInstall.mockClear();
    mockList.mockClear();
    mockConfigDir = tmpServiceConfigDir;
    mockLogDir = tmpLogDir;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('agent');
    registerAgentInstall(program);

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    for (const dir of [tmpInstanceDir, tmpConfigRoot, tmpLogDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Run the install command with the given args and the canonical defaults. */
  async function runInstall(extraArgs: string[] = []): Promise<void> {
    await program.parseAsync([
      'node',
      'agent',
      'install',
      '--name',
      'kici-test',
      '--instance-dir',
      tmpInstanceDir,
      '--binary',
      process.execPath,
      ...extraArgs,
    ]);
  }

  it('writes the manifest into --instance-dir', async () => {
    await runInstall();

    const file = path.join(tmpInstanceDir, '.kici-agent.json');
    expect(fs.existsSync(file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(manifest.component).toBe('agent');
    expect(manifest.name).toBe('kici-test');
    expect(manifest.platform).toBe('systemd');
    expect(manifest.isUserLevel).toBe(true);
    expect(manifest.configDir).toBe(tmpServiceConfigDir);
    expect(manifest.logDir).toBe(tmpLogDir);
    expect(typeof manifest.createdAt).toBe('string');
    expect(typeof manifest.installBase).toBe('string');
  });

  it('appends an entry to <kiciRoot>/instances.json', async () => {
    await runInstall();

    const entries = readIndex(tmpConfigRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      component: 'agent',
      name: 'kici-test',
      platform: 'systemd',
      isUserLevel: true,
      instanceDir: path.resolve(tmpInstanceDir),
    });
  });

  it('passes component: agent to manager.install()', async () => {
    await runInstall();

    expect(mockInstall).toHaveBeenCalledTimes(1);
    const cfg = mockInstall.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.component).toBe('agent');
    expect(cfg.name).toBe('kici-test');
  });

  it('refuses to overwrite a same-named foreign instance (no --force)', async () => {
    mockListResult = [
      {
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        component: 'agent',
      },
    ];
    // Pre-populate the index with the foreign instanceDir so listInstances
    // reports it back via the index reconciliation.
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpConfigRoot, 'instances.json'),
      JSON.stringify(
        [
          {
            component: 'agent',
            name: 'kici-test',
            platform: 'systemd',
            isUserLevel: true,
            instanceDir: '/other/place',
          },
        ],
        null,
        2,
      ),
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(runInstall()).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errArgs).toContain('already installed at /other/place');
    expect(mockInstall).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('refuses when the existing entry has no instanceDir (scan-only)', async () => {
    // listInstances returns a scan-only entry — there is no row in the index
    // for this instance, so the discovered instance has no instanceDir. The
    // guard must still refuse without --force.
    mockListResult = [
      {
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        component: 'agent',
      },
    ];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(runInstall()).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errArgs = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errArgs).toContain('(no manifest)');
    expect(mockInstall).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('overwrites with --force', async () => {
    mockListResult = [
      {
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        component: 'agent',
      },
    ];
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpConfigRoot, 'instances.json'),
      JSON.stringify(
        [
          {
            component: 'agent',
            name: 'kici-test',
            platform: 'systemd',
            isUserLevel: true,
            instanceDir: '/other/place',
          },
        ],
        null,
        2,
      ),
    );

    await runInstall(['--force']);

    expect(mockInstall).toHaveBeenCalledTimes(1);
    const file = manifestPath(tmpInstanceDir, 'agent');
    expect(fs.existsSync(file)).toBe(true);
    // appendIndexEntry refuses to overwrite when the foreign entry is still
    // there; the action catches and warns instead of failing.
    const warns = consoleWarnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warns).toContain('instance index append failed');
  });

  it('is idempotent when instanceDir matches the existing entry', async () => {
    const resolvedInstanceDir = path.resolve(tmpInstanceDir);
    mockListResult = [
      {
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        component: 'agent',
      },
    ];
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpConfigRoot, 'instances.json'),
      JSON.stringify(
        [
          {
            component: 'agent',
            name: 'kici-test',
            platform: 'systemd',
            isUserLevel: true,
            instanceDir: resolvedInstanceDir,
          },
        ],
        null,
        2,
      ),
    );

    await runInstall();

    expect(mockInstall).toHaveBeenCalledTimes(1);
    const entries = readIndex(tmpConfigRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.instanceDir).toBe(resolvedInstanceDir);
    expect(fs.existsSync(manifestPath(tmpInstanceDir, 'agent'))).toBe(true);
  });

  it('defaults --instance-dir to the current working directory', async () => {
    const savedCwd = process.cwd();
    try {
      process.chdir(tmpInstanceDir);
      await program.parseAsync([
        'node',
        'agent',
        'install',
        '--name',
        'kici-test',
        '--binary',
        process.execPath,
      ]);

      const file = path.join(tmpInstanceDir, '.kici-agent.json');
      expect(fs.existsSync(file)).toBe(true);
      const entries = readIndex(tmpConfigRoot);
      expect(entries[0]!.instanceDir).toBe(path.resolve(tmpInstanceDir));
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('calls runAgentWizard and writes env file with correct content when --wizard is passed', async () => {
    await runInstall(['--wizard']);

    const { runAgentWizard } = await import('../../wizard/agent-wizard.js');
    expect(runAgentWizard).toHaveBeenCalled();

    // The wizard env file lives in the resolved config dir (tmpServiceConfigDir).
    const envFile = path.join(tmpServiceConfigDir, 'kici-test.env');
    expect(fs.existsSync(envFile)).toBe(true);
    const content = fs.readFileSync(envFile, 'utf-8');
    expect(content).toContain('KICI_ORCHESTRATOR_URL=http://orch.example.com:4000');
    expect(content).toContain('KICI_AGENT_TOKEN=test-token-abc123');
    expect(content).toContain('KICI_AGENT_LABELS=linux,x64');
    expect(content).toContain('generated by setup wizard');
  });

  it('rejects --wizard combined with --env-file', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(runInstall(['--wizard', '--env-file', '/some/file.env'])).rejects.toThrow(
      'process.exit called',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Cannot use --wizard with --env-file');

    exitSpy.mockRestore();
  });
});
