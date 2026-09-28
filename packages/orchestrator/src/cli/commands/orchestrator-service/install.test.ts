/**
 * Tests for the orchestrator install command's folder-anchored behavior:
 * --instance-dir handling, manifest write, index append, create-path guard,
 * and the component marker passed through to manager.install().
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
const mockRestrict = vi.fn();
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
    restrictEnvFileAccess: (...args: unknown[]) => mockRestrict(...args),
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

// Import after mocks so the action picks up the mocked module.
import { registerOrchestratorInstall } from './install.js';
import { readIndex, manifestPath, readKiciVersion } from '../../service/index.js';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('orchestrator install — folder-anchored', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let tmpServiceConfigDir: string;
  let tmpLogDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-e1-i-');
    tmpConfigRoot = mkTmp('kici-e1-c-');
    tmpServiceConfigDir = path.join(tmpConfigRoot, 'kici-test') + path.sep;
    tmpLogDir = mkTmp('kici-e1-l-');

    mockListResult = [];
    mockComposeListResult = [];
    mockInstall.mockClear();
    mockRestrict.mockReset();
    mockList.mockClear();
    mockComposeList.mockClear();
    mockConfigDir = tmpServiceConfigDir;
    mockLogDir = tmpLogDir;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('orchestrator');
    registerOrchestratorInstall(program);

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
      'orchestrator',
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

  it('writes the enumerated stub env file when no --env-file is given', async () => {
    await runInstall();

    const envFile = path.join(tmpServiceConfigDir, 'kici-test.env');
    const content = fs.readFileSync(envFile, 'utf-8');
    expect(content).toContain('KICI_DATABASE_URL');
    expect(content).toContain('KICI_PLATFORM_TOKEN');
    expect(content).toContain('KICI_BOOTSTRAP_ADMIN_TOKEN');
    expect(content).toContain('openssl rand -hex 32');
    expect(content).toContain('https://docs.kici.dev/user/quickstart/compose/');
    // Token-vocabulary cross-reference lives in the stub comments.
    expect(content).toContain('kici_ok_');
    expect(content).toContain('kici_join_v1');
  });

  it('defaults the installed mode to hybrid', async () => {
    await runInstall();

    const content = fs.readFileSync(path.join(tmpServiceConfigDir, 'kici-test.env'), 'utf-8');
    expect(content).toContain('KICI_MODE=hybrid');
    expect(content).toContain('# KICI_WEBHOOK_PUBLIC_URL=');
  });

  it('writes the mode named by --mode', async () => {
    await runInstall(['--mode', 'platform']);

    const content = fs.readFileSync(path.join(tmpServiceConfigDir, 'kici-test.env'), 'utf-8');
    expect(content).toContain('KICI_MODE=platform');
  });

  // The whole point of --mode on an env-file install: the unit's entry point
  // is baked here, so a mode the operator sets afterwards can never take
  // effect. Asserting only the env file's KICI_MODE line would miss the half
  // that matters — mockInstall receives the ServiceConfig the unit is written
  // from, so the resolved script is what the test reads.
  it('an --env-file install honours --mode, down to the resolved server entry', async () => {
    const source = path.join(tmpInstanceDir, 'joined.env');
    // The artifact `kici-admin join` writes: KICI_MODE only inside a comment.
    fs.writeFileSync(source, '#   KICI_MODE=hybrid\nKICI_DATABASE_URL=postgres://x\n', 'utf-8');

    await program.parseAsync([
      'node',
      'orchestrator',
      'install',
      '--name',
      'kici-test',
      '--instance-dir',
      tmpInstanceDir,
      '--env-file',
      source,
      '--mode',
      'independent',
    ]);

    const content = fs.readFileSync(path.join(tmpServiceConfigDir, 'kici-test.env'), 'utf-8');
    expect(content).toContain('KICI_MODE=independent');
    const config = mockInstall.mock.calls[0][0] as ServiceConfig;
    expect(config.args?.[0]).toMatch(/standalone\.js$/);
  });

  // breaks-if-wrong: --mode carries a Commander default, so a bare install
  //   must leave a mode the operator already put in the file alone — writing
  //   hybrid over it would point a joined peer at the wrong server.
  it('an --env-file install without --mode keeps the mode already in the file', async () => {
    const source = path.join(tmpInstanceDir, 'joined.env');
    fs.writeFileSync(source, 'KICI_MODE=independent\nKICI_DATABASE_URL=postgres://x\n', 'utf-8');

    await program.parseAsync([
      'node',
      'orchestrator',
      'install',
      '--name',
      'kici-test',
      '--instance-dir',
      tmpInstanceDir,
      '--env-file',
      source,
    ]);

    const content = fs.readFileSync(path.join(tmpServiceConfigDir, 'kici-test.env'), 'utf-8');
    expect(content).toContain('KICI_MODE=independent');
    expect(content).not.toContain('KICI_MODE=hybrid');
    const config = mockInstall.mock.calls[0][0] as ServiceConfig;
    expect(config.args?.[0]).toMatch(/standalone\.js$/);
  });

  it('refuses a --mode outside the mode vocabulary', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(runInstall(['--mode', 'relayish'])).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errArgs = consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(errArgs).toContain('--mode must be one of');
    for (const mode of ['platform', 'hybrid', 'independent', 'observed']) {
      expect(errArgs).toContain(mode);
    }
    expect(mockInstall).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('writes the manifest into --instance-dir', async () => {
    await runInstall();

    const file = path.join(tmpInstanceDir, '.kici-orchestrator.json');
    expect(fs.existsSync(file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(manifest.component).toBe('orchestrator');
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
      component: 'orchestrator',
      name: 'kici-test',
      platform: 'systemd',
      isUserLevel: true,
      instanceDir: path.resolve(tmpInstanceDir),
    });
  });

  // fails-when: the Windows install writes the env file into a folder that
  // still grants BUILTIN\Users read.
  it('restricts the config folder on Windows before it writes the env file', async () => {
    const { detectPlatform, resolveUserLevel } = await import('../../service/index.js');
    const envFile = path.join(tmpServiceConfigDir, 'kici-test.env');
    let envFileExistedAtRestrict: boolean | undefined;
    mockRestrict.mockImplementation((envFilePath: string) => {
      envFileExistedAtRestrict = fs.existsSync(envFilePath);
    });
    vi.mocked(detectPlatform).mockReturnValue('windows');
    vi.mocked(resolveUserLevel).mockReturnValue(false);
    try {
      await runInstall();
    } finally {
      vi.mocked(detectPlatform).mockReturnValue('systemd');
      vi.mocked(resolveUserLevel).mockReturnValue(true);
    }

    expect(mockRestrict).toHaveBeenCalledWith(envFile);
    expect(envFileExistedAtRestrict).toBe(false);
    // Positive control: the install wrote the env file after the restriction.
    expect(fs.existsSync(envFile)).toBe(true);
  });

  // breaks-if-wrong: a systemd, launchd or compose install runs no icacls.
  it('never restricts through icacls on other platforms', async () => {
    await runInstall();
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(mockRestrict).not.toHaveBeenCalled();
  });

  // breaks-if-wrong: a user-level folder in the profile of its user is already
  // private, and restricting it would lock that user out of it.
  it('leaves a user-level Windows folder to the ACL of the profile', async () => {
    const { detectPlatform } = await import('../../service/index.js');
    vi.mocked(detectPlatform).mockReturnValue('windows');
    try {
      await runInstall();
    } finally {
      vi.mocked(detectPlatform).mockReturnValue('systemd');
    }
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(mockRestrict).not.toHaveBeenCalled();
  });

  it('passes component: orchestrator to manager.install()', async () => {
    await runInstall();

    expect(mockInstall).toHaveBeenCalledTimes(1);
    const cfg = mockInstall.mock.calls[0]![0] as ServiceConfig;
    expect(cfg.component).toBe('orchestrator');
    expect(cfg.name).toBe('kici-test');
  });

  it('refuses to overwrite a same-named foreign instance (no --force)', async () => {
    mockListResult = [
      {
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        component: 'orchestrator',
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
            component: 'orchestrator',
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
    // The error must point at the upgrade path, for an npm install and for a
    // versioned-directory install, as well as the second-instance collision
    // overrides (--name / --instance-dir / --force).
    expect(errArgs).toContain('kici-admin orchestrator upgrade --version <version>');
    expect(errArgs).toContain(
      'kici-admin orchestrator upgrade --from <archive> --version <version>',
    );
    expect(errArgs).toContain('--name');
    expect(errArgs).toContain('--instance-dir');
    expect(errArgs).toContain('--force');
    expect(mockInstall).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  // fails-when: the guard names one host-derived driver — `listInstances({…,
  // managers: [manager]})`. The systemd scan returns nothing, the compose
  // driver's scan spy never runs, and a compose orchestrator of this name at
  // another path is invisible, so the install proceeds — the clobber the guard
  // exists to refuse. Measured on a scratchpad copy: that edit reddens this
  // test on both the refusal and the compose-scan assertion.
  it('refuses a same-named compose instance on a systemd host', async () => {
    mockComposeListResult = [
      {
        name: 'kici-test',
        platform: 'compose',
        isUserLevel: true,
        component: 'orchestrator',
      },
    ];
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpConfigRoot, 'instances.json'),
      JSON.stringify(
        [
          {
            component: 'orchestrator',
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
        component: 'orchestrator',
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
        component: 'orchestrator',
      },
    ];
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpConfigRoot, 'instances.json'),
      JSON.stringify(
        [
          {
            component: 'orchestrator',
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
    const file = manifestPath(tmpInstanceDir, 'orchestrator');
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
        component: 'orchestrator',
      },
    ];
    fs.mkdirSync(tmpConfigRoot, { recursive: true });
    fs.writeFileSync(
      path.join(tmpConfigRoot, 'instances.json'),
      JSON.stringify(
        [
          {
            component: 'orchestrator',
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
    expect(fs.existsSync(manifestPath(tmpInstanceDir, 'orchestrator'))).toBe(true);
  });

  // fails-when: install writes its fresh manifest over the one in the folder,
  // dropping the heads the rollback schema guard reads and the creation time.
  it('re-running install keeps the migration heads and creation time it recorded', async () => {
    fs.writeFileSync(
      manifestPath(tmpInstanceDir, 'orchestrator'),
      JSON.stringify({
        component: 'orchestrator',
        name: 'kici-test',
        platform: 'systemd',
        isUserLevel: true,
        envFilePath: '/old/kici-test.env',
        configDir: '/old/',
        logDir: '/old/logs/',
        installBase: '/opt/kici/kici-test/',
        createdAt: '2026-01-02T03:04:05.000Z',
        kiciVersion: '0.9.0',
        migrationHeads: { '0.9.0': '040_previous_head' },
      }),
    );

    await runInstall();

    const manifest = JSON.parse(
      fs.readFileSync(manifestPath(tmpInstanceDir, 'orchestrator'), 'utf-8'),
    );
    expect(manifest.migrationHeads).toEqual({ '0.9.0': '040_previous_head' });
    expect(manifest.createdAt).toBe('2026-01-02T03:04:05.000Z');
    // `--binary node` shows no version, so the recorded one stands.
    expect(manifest.kiciVersion).toBe('0.9.0');
    // Everything install derives comes from this install.
    expect(manifest.configDir).toBe(tmpServiceConfigDir);
    expect(manifest.logDir).toBe(tmpLogDir);
    expect(manifest.envFilePath).toBe(path.join(tmpServiceConfigDir, 'kici-test.env'));
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('manifest'));
  });

  // breaks-if-wrong: a first install still records the CLI's own version.
  it('a first install records the version of the CLI that ran it', async () => {
    const started = Date.now();
    await runInstall();
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath(tmpInstanceDir, 'orchestrator'), 'utf-8'),
    );
    expect(manifest.kiciVersion).toBe(readKiciVersion());
    expect(Date.parse(manifest.createdAt)).toBeGreaterThanOrEqual(started - 1_000);
    expect(manifest.migrationHeads).toBeUndefined();
  });

  it('warns when it replaces a manifest it cannot read', async () => {
    fs.writeFileSync(manifestPath(tmpInstanceDir, 'orchestrator'), '{ not json');
    await runInstall();
    const warns = consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(warns).toMatch(/malformed instance manifest/i);
    expect(
      JSON.parse(fs.readFileSync(manifestPath(tmpInstanceDir, 'orchestrator'), 'utf-8')).name,
    ).toBe('kici-test');
  });

  it('defaults --instance-dir to the current working directory', async () => {
    const savedCwd = process.cwd();
    try {
      process.chdir(tmpInstanceDir);
      await program.parseAsync([
        'node',
        'orchestrator',
        'install',
        '--name',
        'kici-test',
        '--binary',
        process.execPath,
      ]);

      const file = path.join(tmpInstanceDir, '.kici-orchestrator.json');
      expect(fs.existsSync(file)).toBe(true);
      const entries = readIndex(tmpConfigRoot);
      expect(entries[0]!.instanceDir).toBe(path.resolve(tmpInstanceDir));
    } finally {
      process.chdir(savedCwd);
    }
  });
});
