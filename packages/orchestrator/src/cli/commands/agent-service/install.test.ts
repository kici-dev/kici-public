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
import type {
  DiscoveredInstance,
  ServiceConfig,
  ServiceManager,
  ServicePlatform,
} from '../../service/types.js';

// Per-test mock state. Reassigned in beforeEach so each test gets its own
// tmpdirs + a clean manager stub.
/** The systemd driver's scan. */
let mockListResult: DiscoveredInstance[] = [];
/** The compose driver's scan — a compose install the systemd driver cannot see. */
let mockComposeListResult: DiscoveredInstance[] = [];
const mockInstall = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn(async (_isUserLevel: boolean) => mockListResult);
const mockComposeList = vi.fn(async (_isUserLevel: boolean) => mockComposeListResult);
let mockConfigDir = '';
let mockLogDir = '';
let mockKiciRoot = '';

vi.mock('../../service/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../service/index.js')>('../../service/index.js');

  const makeManager = (platform: ServicePlatform): ServiceManager =>
    ({
      platform,
      install: (...args: unknown[]) => mockInstall(...args),
      list: (...args: unknown[]) =>
        platform === 'compose'
          ? mockComposeList(...(args as Parameters<typeof mockComposeList>))
          : mockList(...(args as Parameters<typeof mockList>)),
    }) as unknown as ServiceManager;

  return {
    ...actual,
    detectPlatform: vi.fn().mockReturnValue('systemd'),
    resolveUserLevel: vi.fn().mockReturnValue(true),
    getConfigDir: vi.fn(() => mockConfigDir),
    getLogDir: vi.fn(() => mockLogDir),
    kiciConfigRoot: vi.fn(() => mockKiciRoot),
    createServiceManager: vi.fn(async (platform: ServicePlatform) => makeManager(platform)),
    // Substitute the drivers so the host's real systemd and compose registries
    // stay out of the test. A caller that names its own driver set keeps it,
    // mapped one-for-one onto doubles — so a guard that asks for a single
    // host-derived driver scans a single double, and the compose row it would
    // then miss is really missed. Only a caller that names none gets the
    // candidate pair, which is what `candidateManagers()` would have built.
    //
    // The substitution alone cannot show which of the two the guard asked for,
    // so the guard test asserts the compose driver's own scan spy ran.
    listInstances: (args: Parameters<typeof actual.listInstances>[0]) =>
      actual.listInstances({
        ...args,
        managers: args.managers
          ? args.managers.map((m) => makeManager(m.platform))
          : [makeManager('systemd'), makeManager('compose')],
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
    mockComposeListResult = [];
    mockInstall.mockClear();
    mockList.mockClear();
    mockComposeList.mockClear();
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

  // The driver set the create-path guard scans, pinned on its own. In the
  // refusal test below, the compose scan is implied by the refusal firing at
  // all, so it cannot fail there independently; here nothing conflicts and the
  // install succeeds, so this assertion is the only thing a single-driver guard
  // would break.
  //
  // fails-when: the guard names one host-derived driver — `listInstances({…,
  // managers: [manager]})`. The compose double is never built and its scan
  // never runs.
  it('scans every candidate driver, not only the host platform', async () => {
    await runInstall();

    expect(mockList).toHaveBeenCalled();
    expect(mockComposeList).toHaveBeenCalled();
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

  // fails-when: the guard names one host-derived driver — `listInstances({…,
  // managers: [manager]})`. The systemd scan returns nothing, the compose
  // driver's scan spy never runs, and a compose agent of this name at another
  // path is invisible, so the install proceeds — the clobber the guard exists
  // to refuse. Measured on a scratchpad copy: that edit reddens this test on
  // both the refusal and the compose-scan assertion.
  it('refuses a same-named compose instance on a systemd host', async () => {
    mockComposeListResult = [
      {
        name: 'kici-test',
        platform: 'compose',
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
            platform: 'compose',
            isUserLevel: true,
            instanceDir: '/other/compose/place',
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
    // Both drivers ran, which is the axis: the compose row is only reachable
    // because the guard scanned a driver the host's own platform did not name.
    expect(mockList).toHaveBeenCalled();
    expect(mockComposeList).toHaveBeenCalled();
    const errArgs = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(errArgs).toContain('already installed at /other/compose/place');
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

  // fails-when: the env file is written under the ambient umask while holding
  //   KICI_AGENT_TOKEN, publishing the agent's credential to every local
  //   account. breaks-if-wrong: the content assertion above reads the same
  //   file back, so an over-tightened mode that made it unreadable would fail
  //   that test rather than pass this one.
  it('writes the wizard env file readable by its owner only', async () => {
    await runInstall(['--wizard']);

    const envFile = path.join(tmpServiceConfigDir, 'kici-test.env');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  // fails-when: an env file copied in with --env-file keeps the source's mode.
  //   A 0644 source hands the agent token to every local account.
  it('tightens a world-readable --env-file it copies in', async () => {
    fs.mkdirSync(tmpServiceConfigDir, { recursive: true });
    const source = path.join(tmpServiceConfigDir, 'source.env');
    fs.writeFileSync(source, 'KICI_AGENT_TOKEN=abc\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(source, 0o644);

    await runInstall(['--env-file', source]);

    const envFile = path.join(tmpServiceConfigDir, 'kici-test.env');
    expect(fs.readFileSync(envFile, 'utf-8')).toContain('KICI_AGENT_TOKEN=abc');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  // The final mode says nothing about the moment before the chmod. A second
  // hard link on the destination makes that moment observable: a write through
  // the old inode would put the agent token on a file still at 0644.
  // fails-when: the install copies with copyFileSync and chmods afterwards.
  it('never writes the agent token through a pre-existing world-readable file', async () => {
    fs.mkdirSync(tmpServiceConfigDir, { recursive: true });
    const envFile = path.join(tmpServiceConfigDir, 'kici-test.env');
    const keeper = path.join(tmpServiceConfigDir, 'keeper');
    fs.writeFileSync(envFile, 'stale\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(envFile, 0o644);
    fs.linkSync(envFile, keeper);
    const source = path.join(tmpServiceConfigDir, 'source.env');
    fs.writeFileSync(source, 'KICI_AGENT_TOKEN=abc\n', { encoding: 'utf-8', mode: 0o644 });
    fs.chmodSync(source, 0o644);

    await runInstall(['--env-file', source]);

    expect(fs.readFileSync(envFile, 'utf-8')).toContain('KICI_AGENT_TOKEN=abc');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keeper, 'utf-8')).toBe('stale\n');
    expect(fs.statSync(keeper).mode & 0o777).toBe(0o644);
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
