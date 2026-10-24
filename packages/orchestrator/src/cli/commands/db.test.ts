/**
 * `kici-admin db` tests, on two axes:
 *
 * 1. Registration and audit-log wiring: which subcommands record an
 *    access-log entry and which must not.
 * 2. `db backup --install-timer` / `--uninstall-timer`. The driver and the
 *    unit's platform come from the install's manifest, so on a systemd host
 *    with a compose install `unsupportedPlatformMessage` must fire, not render
 *    a systemd unit aimed at an unreachable container. The real timer module
 *    runs through an in-memory TimerIo, so no unit file reaches the host.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { makeTempDir } from '@kici-dev/test-support/tmp';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredInstance, ServiceManager, ServicePlatform } from '../service/types.js';

const mockRecordOnDb = vi.fn();
const mockRecord = vi.fn();
vi.mock('./shared/admin-cli-access-log.js', () => ({
  recordAdminCliAccessOnDb: (...a: unknown[]) => mockRecordOnDb(...a),
  recordAdminCliAccess: (...a: unknown[]) => mockRecord(...a),
}));

// The URL helpers stay real; only DDL side-effects are stubbed, so no live DB is needed.
const mockDropAndCreate = vi.fn(async () => undefined);
const mockEnsureDatabase = vi.fn(async () => 'created');
const mockCreateDbRole = vi.fn(async () => 'created');
const mockCreateReadOnly = vi.fn(async () => 'created');
const mockIsSchemaCurrent = vi.fn(async () => ({ current: true }));
const mockFingerprintSchema = vi.fn();
vi.mock('@kici-dev/shared', async (importActual) => {
  const actual = await importActual<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createPool: vi.fn(() => ({ end: vi.fn(async () => undefined) })),
    dropAndCreateDatabase: (...a: unknown[]) => mockDropAndCreate(...(a as [])),
    ensureDatabase: (...a: unknown[]) => mockEnsureDatabase(...(a as [])),
    createDbRole: (...a: unknown[]) => mockCreateDbRole(...(a as [])),
    createReadOnlyDbUser: (...a: unknown[]) => mockCreateReadOnly(...(a as [])),
    isSchemaCurrent: (...a: unknown[]) => mockIsSchemaCurrent(...(a as [])),
    fingerprintSchema: (...a: unknown[]) => mockFingerprintSchema(...a),
    computeMigrationsHash: vi.fn(async () => 'abcdef012345deadbeef'),
  };
});

const mockReindex = vi.fn(async () => undefined);
const mockRefresh = vi.fn(async () => undefined);
vi.mock('@kici-dev/shared/db-collation', () => ({
  getDatabaseCollationDrift: vi.fn(async () => null),
  reindexDatabaseConcurrently: (...a: unknown[]) => mockReindex(...(a as [])),
  refreshDatabaseCollationVersion: (...a: unknown[]) => mockRefresh(...(a as [])),
}));

const mockStatsReport = vi.fn();
const mockResolveTargets = vi.fn();
const mockAnalyzeTables = vi.fn(async () => undefined);
vi.mock('@kici-dev/shared/db-stats', async (importActual) => {
  const actual = await importActual<typeof import('@kici-dev/shared/db-stats')>();
  return {
    ...actual,
    getGinTableStatsReport: (...a: unknown[]) => mockStatsReport(...a),
    resolveAnalyzeTargets: (...a: unknown[]) => mockResolveTargets(...a),
    analyzeTables: (...a: unknown[]) => mockAnalyzeTables(...(a as [])),
  };
});

vi.mock('../../db/client.js', () => ({
  createDb: vi.fn(() => ({ destroy: vi.fn(async () => undefined) })),
}));
vi.mock('../../db/migration-provider.js', () => ({
  createMigrationProvider: vi.fn(() => ({})),
}));
vi.mock('../../db/migrator.js', () => ({
  runMigrations: vi.fn(async () => [{ status: 'Success' }]),
}));

/** What each driver's scan returns, so a union scan can be told from a single one. */
let mockListByPlatform: Partial<Record<ServicePlatform, DiscoveredInstance[]>> = {};
let mockKiciRoot = '';

/** Platforms handed to the backup-timer installer, in call order. */
const timerPlatforms: ServicePlatform[] = [];
/** Platforms whose driver discovery actually scanned. */
const scannedPlatforms: ServicePlatform[] = [];

vi.mock('../service/index.js', async () => {
  const actual = await vi.importActual<typeof import('../service/index.js')>('../service/index.js');

  const makeManager = (platform: ServicePlatform): ServiceManager =>
    ({
      platform,
      install: vi.fn(),
      uninstall: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      status: vi.fn(),
      logs: vi.fn(),
      isInstalled: vi.fn(),
      list: async () => {
        scannedPlatforms.push(platform);
        return mockListByPlatform[platform] ?? [];
      },
    }) as unknown as ServiceManager;

  return {
    ...actual,
    detectPlatform: vi.fn().mockReturnValue('systemd'),
    resolveUserLevel: vi.fn().mockReturnValue(true),
    kiciConfigRoot: vi.fn(() => mockKiciRoot),
    createServiceManager: vi.fn(async (platform: ServicePlatform) => makeManager(platform)),
    // The real manager selection runs, with the driver factory injected.
    resolveInstanceTarget: (args: Parameters<typeof actual.resolveInstanceTarget>[0]) =>
      actual.resolveInstanceTarget({ ...args, createManager: async (p) => makeManager(p) }),
  };
});

// The real resolveInstanceTarget imports detectPlatform from platform-detect.js
// directly, past the barrel mock; pin it here too (as resolve.test.ts does) so
// "a systemd host" holds on any host.
vi.mock('../service/platform-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../service/platform-detect.js')>();
  return { ...actual, detectPlatform: vi.fn((): ServicePlatform => 'systemd') };
});

vi.mock('../service/backup-timer.js', async () => {
  const actual = await vi.importActual<typeof import('../service/backup-timer.js')>(
    '../service/backup-timer.js',
  );
  // The shipped bodies and their platform assertion run; nothing reaches the host.
  const io = {
    mkdirp: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(() => 'KICI_DATABASE_URL=postgres://x/y\n'),
    removeFile: vi.fn(),
    run: vi.fn(),
  };
  return {
    ...actual,
    installBackupTimer: (
      platform: ServicePlatform,
      config: Parameters<typeof actual.installBackupTimer>[1],
    ) => {
      timerPlatforms.push(platform);
      return actual.installBackupTimer(platform, config, io);
    },
    uninstallBackupTimer: (
      platform: ServicePlatform,
      config: Parameters<typeof actual.uninstallBackupTimer>[1],
    ) => {
      timerPlatforms.push(platform);
      return actual.uninstallBackupTimer(platform, config, io);
    },
  };
});

import { registerDbCommands } from './db.js';
import { DEFERRED_INDEXES } from '../../db/deferred-indexes.js';
import { SCHEMA_SNAPSHOT } from '../../db/schema-snapshot.generated.js';
import { writeManifest } from '../service/index.js';
import type { InstanceManifest } from '../service/index.js';
import { detectPlatform } from '../service/platform-detect.js';

function buildDbCommand(): Command {
  const program = new Command();
  program.exitOverride();
  const mockGetClient = () => ({}) as never;
  registerDbCommands(program, mockGetClient);
  return program.commands.find((c) => c.name() === 'db')!;
}

/** Runs a db subcommand through a fresh program. */
async function runDb(args: string[]): Promise<{ exitCode: number | null; stdout: string }> {
  const program = new Command();
  program.exitOverride();
  registerDbCommands(program, () => ({}) as never);

  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  const origWrite = process.stderr.write;
  const origStdoutWrite = process.stdout.write;
  let exitCode: number | null = null;
  let stdout = '';

  console.log = (...a: unknown[]) => {
    stdout += a.join(' ') + '\n';
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as never;
  console.error = () => undefined;
  process.stderr.write = (() => true) as never;
  process.exit = ((code?: number) => {
    // The first exit wins: cliAction's catch would otherwise turn exit(2) into exit(1).
    exitCode ??= code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.startsWith('EXIT:') && !(err as { code?: string }).code?.startsWith('commander.')) {
      // Re-throw genuine test failures.
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
      process.stderr.write = origWrite;
      process.stdout.write = origStdoutWrite;
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    process.stderr.write = origWrite;
    process.stdout.write = origStdoutWrite;
  }
  return { exitCode, stdout };
}

describe('kici-admin db namespace', () => {
  it('registers migrate (existing HTTP-based)', () => {
    const db = buildDbCommand();
    const migrate = db.commands.find((c) => c.name() === 'migrate');
    expect(migrate).toBeDefined();
    expect(migrate!.options.map((o) => o.long)).toContain('--status');
  });

  it('registers fresh with --confirm required and --yes / --database-url optional', () => {
    const db = buildDbCommand();
    const fresh = db.commands.find((c) => c.name() === 'fresh');
    expect(fresh).toBeDefined();
    const required = fresh!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain('--confirm');
    const flags = fresh!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--database-url', '--yes']));
  });

  it('registers ensure <name>', () => {
    const db = buildDbCommand();
    const ensure = db.commands.find((c) => c.name() === 'ensure');
    expect(ensure).toBeDefined();
    expect(ensure!.options.map((o) => o.long)).toContain('--database-url');
    expect(ensure!.options.map((o) => o.long)).toContain('--grant-connect-role');
  });

  it('registers create-role with required user/password and optional createdb', () => {
    const db = buildDbCommand();
    const createRole = db.commands.find((c) => c.name() === 'create-role');
    expect(createRole).toBeDefined();
    const required = createRole!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--user', '--password']));
    expect(createRole!.options.map((o) => o.long)).toContain('--createdb');
  });

  it('registers create-readonly-user with required user/password', () => {
    const db = buildDbCommand();
    const createRo = db.commands.find((c) => c.name() === 'create-readonly-user');
    expect(createRo).toBeDefined();
    const required = createRo!.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--user', '--password']));
  });

  it('registers check-schema with --json', () => {
    const db = buildDbCommand();
    const check = db.commands.find((c) => c.name() === 'check-schema');
    expect(check).toBeDefined();
    expect(check!.options.map((o) => o.long)).toContain('--json');
  });
});

describe('db subcommands access-log', () => {
  beforeEach(() => {
    mockRecordOnDb.mockClear();
    mockRecord.mockClear();
  });

  it('records db.fresh after fresh (on the schema-bearing handle)', async () => {
    const { exitCode } = await runDb([
      'db',
      'fresh',
      '--database-url',
      'postgres://u:p@h:5432/kici',
      '--confirm',
      '--yes',
    ]);
    expect(exitCode).toBeNull();
    expect(mockRecordOnDb).toHaveBeenCalledTimes(1);
    expect(mockRecordOnDb.mock.calls[0][1].action).toBe('db.fresh');
    expect(mockRecordOnDb.mock.calls[0][1].target).toEqual({ type: 'database', id: 'kici' });
  });

  it('records db.reindex after reindex', async () => {
    await runDb([
      'db',
      'reindex',
      '--database-url',
      'postgres://u:p@h:5432/kici',
      '--confirm',
      '--reason',
      'libc bump',
    ]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].action).toBe('db.reindex');
    expect(mockRecord.mock.calls[0][0].outcome).toBe('allowed');
    // recorded against the operated DB URL (2nd arg)
    expect(mockRecord.mock.calls[0][1]).toBe('postgres://u:p@h:5432/kici');
  });

  it('records db.refresh_collation_version', async () => {
    await runDb([
      'db',
      'refresh-collation-version',
      '--database-url',
      'postgres://u:p@h:5432/kici',
      '--reason',
      'post-rebuild',
    ]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].action).toBe('db.refresh_collation_version');
  });

  it('records db.ensure', async () => {
    await runDb(['db', 'ensure', 'newdb', '--database-url', 'postgres://u:p@h:5432/postgres']);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].action).toBe('db.ensure');
    expect(mockRecord.mock.calls[0][0].target).toEqual({ type: 'database', id: 'newdb' });
  });

  it('records db.create_role', async () => {
    await runDb([
      'db',
      'create-role',
      '--database-url',
      'postgres://u:p@h:5432/postgres',
      '--user',
      'kici_app',
      '--password',
      'p',
    ]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].action).toBe('db.create_role');
    expect(mockRecord.mock.calls[0][0].target).toEqual({ type: 'database', id: 'kici_app' });
  });

  it('records db.create_readonly_user', async () => {
    await runDb([
      'db',
      'create-readonly-user',
      '--database-url',
      'postgres://u:p@h:5432/kici',
      '--user',
      'ro',
      '--password',
      'p',
    ]);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].action).toBe('db.create_readonly_user');
    expect(mockRecord.mock.calls[0][0].target).toEqual({ type: 'database', id: 'ro' });
    // The operated DB owns access_log, not the bootstrap commands' KICI_DATABASE_URL.
    expect(mockRecord.mock.calls[0][1]).toBe('postgres://u:p@h:5432/kici');
  });

  it('does NOT record on check-schema (read)', async () => {
    await runDb(['db', 'check-schema', '--database-url', 'postgres://u:p@h:5432/kici']);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockRecordOnDb).not.toHaveBeenCalled();
  });

  it('does NOT record on collation-check (read)', async () => {
    await runDb(['db', 'collation-check', '--database-url', 'postgres://u:p@h:5432/kici']);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockRecordOnDb).not.toHaveBeenCalled();
  });
});

describe('kici-admin db schema-diff', () => {
  const URL_ARGS = ['--database-url', 'postgres://u:p@h:5432/kici'];

  beforeEach(() => {
    mockFingerprintSchema.mockReset();
    mockRecord.mockClear();
    mockRecordOnDb.mockClear();
  });

  it('exits 0 and prints "schema matches" when the fingerprint matches', async () => {
    mockFingerprintSchema.mockResolvedValue(structuredClone(SCHEMA_SNAPSHOT));
    const { exitCode, stdout } = await runDb(['db', 'schema-diff', ...URL_ARGS]);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('schema matches');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockRecordOnDb).not.toHaveBeenCalled();
  });

  it('exits 2 and prints each difference', async () => {
    // fails-when: a difference does not change the exit code.
    const drifted = structuredClone(SCHEMA_SNAPSHOT);
    drifted.columns['held_runs.surprise'] = { type: 'text', nullable: true, default: null };
    mockFingerprintSchema.mockResolvedValue(drifted);
    const { exitCode, stdout } = await runDb(['db', 'schema-diff', ...URL_ARGS]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain('extra    columns:held_runs.surprise');
  });

  it('emits the differences as JSON with --json', async () => {
    const drifted = structuredClone(SCHEMA_SNAPSHOT);
    drifted.sequences.push('surprise_seq');
    mockFingerprintSchema.mockResolvedValue(drifted);
    const { exitCode, stdout } = await runDb(['db', 'schema-diff', '--json', ...URL_ARGS]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toEqual({
      differences: [{ path: 'sequences:surprise_seq', kind: 'extra', actual: 'surprise_seq' }],
    });
  });

  it('exits 1 when the database cannot be read', async () => {
    mockFingerprintSchema.mockRejectedValue(new Error('connection refused'));
    const { exitCode } = await runDb(['db', 'schema-diff', ...URL_ARGS]);
    expect(exitCode).toBe(1);
  });

  it('passes the deferred index names as exclusions', async () => {
    // fails-when: the deferred indexes are compared and every live DB reports drift.
    mockFingerprintSchema.mockResolvedValue(structuredClone(SCHEMA_SNAPSHOT));
    await runDb(['db', 'schema-diff', ...URL_ARGS]);
    expect(mockFingerprintSchema.mock.calls[0][1]).toEqual({
      excludeIndexes: DEFERRED_INDEXES.map((i) => i.name),
    });
  });
});

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

describe('db backup --install-timer — the timer follows the install, not the host', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = makeTempDir('kici-db-timer-i-');
    tmpConfigRoot = makeTempDir('kici-db-timer-c-');

    mockListByPlatform = {};
    timerPlatforms.length = 0;
    scannedPlatforms.length = 0;
    mockKiciRoot = tmpConfigRoot;

    program = new Command();
    program.name('kici-admin');
    registerDbCommands(program, () => {
      throw new Error('db timer commands must not reach the HTTP admin API');
    });

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

  function errorOutput(): string {
    return consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  }

  // fails-when: the platform comes from detectPlatform() (mocked to 'systemd'):
  // the refusal never fires and a systemd .service/.timer pair targets an
  // unreachable container.
  it('refuses to install a timer for a compose install on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ platform: 'compose' }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await expect(
        program.parseAsync([
          'node',
          'kici-admin',
          'db',
          'backup',
          '--install-timer',
          '--instance-dir',
          tmpInstanceDir,
        ]),
      ).rejects.toThrow('process.exit called');

      expect(timerPlatforms).toEqual(['compose']);
      expect(errorOutput()).toContain('host scheduler KiCI does');
      expect(errorOutput()).toContain('0 0 * * *');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  // breaks-if-wrong: the supported case must still install; a refusal for every
  // install would break the common case.
  it('installs the timer for a systemd install', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ platform: 'systemd' }));

    await program.parseAsync([
      'node',
      'kici-admin',
      'db',
      'backup',
      '--install-timer',
      '--instance-dir',
      tmpInstanceDir,
    ]);

    expect(timerPlatforms).toEqual(['systemd']);
    expect(errorOutput()).toBe('');
    const logs = consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(logs).toContain('installed scheduled backup "kici-test-db-backup"');
  });

  // Manifest, not host, on removal too: no reported removal of a never-installed timer.
  // fails-when: the platform comes from the host — the refusal is skipped and
  // the command reports a removal.
  it('refuses to uninstall a timer for a compose install on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ platform: 'compose' }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await expect(
        program.parseAsync([
          'node',
          'kici-admin',
          'db',
          'backup',
          '--uninstall-timer',
          '--instance-dir',
          tmpInstanceDir,
        ]),
      ).rejects.toThrow('process.exit called');

      expect(timerPlatforms).toEqual(['compose']);
      expect(errorOutput()).toContain('host scheduler KiCI does');
    } finally {
      exitSpy.mockRestore();
    }
  });

  // Discovery scans every candidate driver, so a compose-only instance resolves on a systemd host.
  // fails-when: discovery runs a single host-derived driver — the compose row is
  // never listed and the command exits with "not found".
  it('resolves a compose-only instance by --name on a systemd host', async () => {
    writeManifest(tmpInstanceDir, makeManifest({ name: 'orch-compose', platform: 'compose' }));
    mockListByPlatform = {
      compose: [
        {
          name: 'orch-compose',
          component: 'orchestrator',
          platform: 'compose',
          isUserLevel: true,
          instanceDir: tmpInstanceDir,
        },
      ],
    };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    try {
      await expect(
        program.parseAsync([
          'node',
          'kici-admin',
          'db',
          'backup',
          '--install-timer',
          '--name',
          'orch-compose',
        ]),
      ).rejects.toThrow('process.exit called');

      // Resolved, then refused for the right reason, not "instance not found".
      expect(scannedPlatforms).toEqual(['systemd', 'compose']);
      // fails-when: the mock above is inert (a wrong module id), so discovery
      // reads the real host; `toHaveBeenCalled` throws on a non-spy.
      expect(vi.mocked(detectPlatform)).toHaveBeenCalled();
      expect(timerPlatforms).toEqual(['compose']);
      expect(errorOutput()).toContain('host scheduler KiCI does');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('kici-admin db stats-check', () => {
  const URL_ARGS = ['--database-url', 'postgres://u:p@h:5432/kici'];
  const healthy = {
    table: 'public.access_log',
    schema: 'public',
    name: 'access_log',
    relkind: 'r',
    reltuples: '120',
    relpages: 3,
    ginIndexes: ['access_log_trgm'],
    problem: null,
  };

  beforeEach(() => {
    mockStatsReport.mockReset();
    mockRecord.mockClear();
  });

  it('exits 0 and prints the clean JSON shape on a healthy DB', async () => {
    // breaks-if-wrong: a healthy DB must exit 0, or every post-upgrade check reads red.
    mockStatsReport.mockResolvedValue({ clean: true, tables: [healthy], needsAnalyze: [] });
    const { exitCode, stdout } = await runDb(['db', 'stats-check', '--json', ...URL_ARGS]);
    expect(exitCode).toBeNull();
    expect(JSON.parse(stdout)).toEqual({
      database: 'kici',
      clean: true,
      tables: [healthy],
      needsAnalyze: [],
    });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('exits 2 and names the table plus the fix when reltuples is invalid', async () => {
    // fails-when: an invalid row is printed but the exit code stays 0.
    const broken = { ...healthy, reltuples: 'NaN', problem: 'nan' };
    mockStatsReport.mockResolvedValue({
      clean: false,
      tables: [broken],
      needsAnalyze: ['public.access_log'],
    });
    const { exitCode, stdout } = await runDb(['db', 'stats-check', ...URL_ARGS]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain('1 table(s) need ANALYZE');
    expect(stdout).toContain('public.access_log  reltuples=NaN  (nan)');
    expect(stdout).toContain("kici-admin db analyze --table public.access_log --reason '<why>'");
  });

  it('exits 1 when the catalog query fails', async () => {
    mockStatsReport.mockRejectedValue(new Error('connection refused'));
    const { exitCode } = await runDb(['db', 'stats-check', ...URL_ARGS]);
    expect(exitCode).toBe(1);
  });
});

describe('kici-admin db analyze', () => {
  const URL_ARGS = ['--database-url', 'postgres://u:p@h:5432/kici'];

  beforeEach(() => {
    mockResolveTargets.mockReset();
    mockAnalyzeTables.mockClear();
    mockRecord.mockClear();
  });

  it('analyzes every --table and records db.analyze against the operated DB', async () => {
    mockResolveTargets.mockResolvedValue([
      { schema: 'public', name: 'access_log' },
      { schema: 'public', name: 'runs' },
    ]);
    const { exitCode, stdout } = await runDb([
      'db',
      'analyze',
      '--table',
      'public.access_log',
      '--table',
      'public.runs',
      '--reason',
      'pg 18.6 reltuples',
      ...URL_ARGS,
    ]);
    expect(exitCode).toBeNull();
    expect(mockResolveTargets.mock.calls[0][1]).toEqual(['public.access_log', 'public.runs']);
    expect(mockAnalyzeTables).toHaveBeenCalledOnce();
    expect(stdout).toContain('db analyze: kici — ANALYZE "public"."access_log" completed');
    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      action: 'db.analyze',
      target: { type: 'database', id: 'kici' },
      outcome: 'allowed',
      meta: { reason: 'pg 18.6 reltuples', tables: ['public.access_log', 'public.runs'] },
    });
    expect(mockRecord.mock.calls[0][1]).toBe('postgres://u:p@h:5432/kici');
  });

  it('--dry-run prints the statements and neither analyzes nor records', async () => {
    mockResolveTargets.mockResolvedValue([{ schema: 'public', name: 'access_log' }]);
    const { exitCode, stdout } = await runDb([
      'db',
      'analyze',
      '--table',
      'public.access_log',
      '--reason',
      'preview',
      '--dry-run',
      ...URL_ARGS,
    ]);
    expect(exitCode).toBeNull();
    expect(stdout.trim()).toBe('ANALYZE "public"."access_log";');
    expect(mockAnalyzeTables).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('exits 1 on an unknown table and analyzes nothing', async () => {
    // fails-when: the validation is skipped and ANALYZE runs on the valid half.
    mockResolveTargets.mockRejectedValue(new Error('Unknown table(s): public.nope.'));
    const { exitCode } = await runDb([
      'db',
      'analyze',
      '--table',
      'public.nope',
      '--reason',
      'typo',
      ...URL_ARGS,
    ]);
    expect(exitCode).toBe(1);
    expect(mockAnalyzeTables).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('requires --table and --reason', async () => {
    const db = buildDbCommand();
    const analyze = db.commands.find((c) => c.name() === 'analyze')!;
    const required = analyze.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--table', '--reason']));
  });
});
