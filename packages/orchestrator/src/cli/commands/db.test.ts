import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

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

const { registerDbCommands } = await import('./db.js');

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
