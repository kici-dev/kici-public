/**
 * Tests for the `kici-admin db` namespace.
 *
 * Two axes live here:
 *
 * 1. Command registration and the audit-log wiring — which db subcommands
 *    record an access-log entry and which must not. The DDL side-effects are
 *    stubbed so the actions run without a live database, while the URL helpers
 *    stay real.
 * 2. `db backup --install-timer` / `--uninstall-timer`. The scheduled backup is
 *    written for one installed orchestrator, so both the driver it resolves
 *    through and the platform it renders a unit for come from that install's
 *    manifest. On a systemd host holding a compose install, the refusal
 *    `unsupportedPlatformMessage` exists for must fire — the timer would
 *    otherwise be a systemd unit pointed at a container KiCI cannot reach. The
 *    timer module is loaded for real and driven through an in-memory TimerIo,
 *    so the refusal under test is the shipped one and no unit file reaches the
 *    host's systemd directory.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredInstance, ServiceManager, ServicePlatform } from '../service/types.js';

const mockRecordOnDb = vi.fn();
const mockRecord = vi.fn();
vi.mock('./shared/admin-cli-access-log.js', () => ({
  recordAdminCliAccessOnDb: (...a: unknown[]) => mockRecordOnDb(...a),
  recordAdminCliAccess: (...a: unknown[]) => mockRecord(...a),
}));

// Keep the URL helpers real (parseDatabaseUrl / maskDatabaseUrl / toErrorMessage)
// and stub only the DDL side-effects so the actions run without a live DB.
const mockDropAndCreate = vi.fn(async () => undefined);
const mockEnsureDatabase = vi.fn(async () => 'created');
const mockCreateDbRole = vi.fn(async () => 'created');
const mockCreateReadOnly = vi.fn(async () => 'created');
const mockIsSchemaCurrent = vi.fn(async () => ({ current: true }));
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
    // Manager selection lives in the seam, so the real one runs here with the
    // driver factory injected.
    resolveInstanceTarget: (args: Parameters<typeof actual.resolveInstanceTarget>[0]) =>
      actual.resolveInstanceTarget({ ...args, createManager: async (p) => makeManager(p) }),
  };
});

vi.mock('../service/backup-timer.js', async () => {
  const actual = await vi.importActual<typeof import('../service/backup-timer.js')>(
    '../service/backup-timer.js',
  );
  // In-memory IO: the shipped install/uninstall bodies run, including their
  // platform assertion, but nothing is written to the host.
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
import { writeManifest } from '../service/index.js';
import type { InstanceManifest } from '../service/index.js';

function buildDbCommand(): Command {
  const program = new Command();
  program.exitOverride();
  const mockGetClient = () => ({}) as never;
  registerDbCommands(program, mockGetClient);
  return program.commands.find((c) => c.name() === 'db')!;
}

/** Execute a db subcommand through a fresh program, capturing exit code. */
async function runDb(args: string[]): Promise<{ exitCode: number | null }> {
  const program = new Command();
  program.exitOverride();
  registerDbCommands(program, () => ({}) as never);

  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  const origWrite = process.stderr.write;
  let exitCode: number | null = null;

  console.log = () => undefined;
  console.error = () => undefined;
  process.stderr.write = (() => true) as never;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
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
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    process.stderr.write = origWrite;
  }
  return { exitCode };
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
    // Records against the operated DB URL (which owns access_log), not the
    // KICI_DATABASE_URL fallback used by the bootstrap-DB provisioning commands.
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

describe('db backup --install-timer — the timer follows the install, not the host', () => {
  let program: Command;
  let tmpInstanceDir: string;
  let tmpConfigRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpInstanceDir = mkTmp('kici-db-timer-i-');
    tmpConfigRoot = mkTmp('kici-db-timer-c-');

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

  // fails-when: the platform comes from detectPlatform(), which the module mock
  // pins to 'systemd'. The compose refusal then never fires and the command
  // writes a systemd .service/.timer pair for a container it cannot reach —
  // exactly the state this test exists to make impossible.
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

  // breaks-if-wrong: the supported case must still install. A refusal that fired
  // for every install would "fix" the compose case by breaking the common one.
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

  // The same manifest-not-host rule on the removal path: a compose install must
  // not be told KiCI removed a timer it never installed.
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

  // The name path has to reach the compose install too: discovery scans every
  // candidate driver, so a compose-only instance resolves on a systemd host.
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

      // It resolved (it reached the timer installer) and then refused for the
      // right reason — not for "instance not found".
      expect(scannedPlatforms).toEqual(['systemd', 'compose']);
      expect(timerPlatforms).toEqual(['compose']);
      expect(errorOutput()).toContain('host scheduler KiCI does');
    } finally {
      exitSpy.mockRestore();
    }
  });
});
