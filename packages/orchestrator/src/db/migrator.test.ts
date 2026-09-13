import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they're available to vi.mock factories
const mockMigrateToLatest = vi.fn();
const mockMigrateTo = vi.fn();
const mockGetMigrations = vi.fn();

vi.mock('kysely/migration', () => ({
  Migrator: class MockMigrator {
    constructor() {
      // no-op
    }
    migrateToLatest = mockMigrateToLatest;
    migrateTo = mockMigrateTo;
    getMigrations = mockGetMigrations;
  },
}));

vi.mock('./migration-provider.js', () => ({
  createMigrationProvider: () => ({
    async getMigrations() {
      return {
        '001_initial': { up: vi.fn(), down: vi.fn() },
        '002_add_sources': { up: vi.fn(), down: vi.fn() },
      };
    },
  }),
}));

const mockComputeMigrationsHash = vi.fn();
const mockStoreMigrationContentHash = vi.fn();
const mockCreatePool = vi.fn();
const mockCreateDb = vi.fn();

vi.mock('@kici-dev/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  computeMigrationsHash: (...args: unknown[]) => mockComputeMigrationsHash(...args),
  storeMigrationContentHash: (...args: unknown[]) => mockStoreMigrationContentHash(...args),
  createPool: (...args: unknown[]) => mockCreatePool(...args),
  createDb: (...args: unknown[]) => mockCreateDb(...args),
}));

// Import after mocks are set up
const {
  runMigrations,
  migrateTo,
  getMigrationStatus,
  createMigrationPool,
  withMigrationPool,
  describeMigrationFailure,
  isStatementTimeoutError,
} = await import('./migrator.js');

function createMockPool() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
  };
  return { mockPool, mockClient };
}

function createMockDb() {
  return {} as any;
}

describe('migrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeMigrationsHash.mockResolvedValue('deadbeef');
    mockStoreMigrationContentHash.mockResolvedValue(undefined);
  });

  describe('runMigrations', () => {
    it('acquires and releases advisory lock around migration', async () => {
      const { mockPool, mockClient } = createMockPool();
      mockMigrateToLatest.mockResolvedValue({ results: [], error: undefined });

      await runMigrations({ db: createMockDb(), pool: mockPool as any });

      // Verify lock was acquired
      expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1)', [543210001]);

      // Verify lock was released
      expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [543210001]);

      // Verify acquire happened before release
      const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      const lockIdx = calls.indexOf('SELECT pg_advisory_lock($1)');
      const unlockIdx = calls.indexOf('SELECT pg_advisory_unlock($1)');
      expect(lockIdx).toBeLessThan(unlockIdx);

      // Verify client was released back to pool
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('calls migrateToLatest between lock acquire and release', async () => {
      const { mockPool, mockClient } = createMockPool();

      const callOrder: string[] = [];
      mockClient.query.mockImplementation(async (sql: string) => {
        if (sql.includes('advisory_lock(')) callOrder.push('lock');
        if (sql.includes('advisory_unlock(')) callOrder.push('unlock');
        return { rows: [] };
      });
      mockMigrateToLatest.mockImplementation(async () => {
        callOrder.push('migrate');
        return { results: [], error: undefined };
      });

      await runMigrations({ db: createMockDb(), pool: mockPool as any });

      expect(callOrder).toEqual(['lock', 'migrate', 'unlock']);
    });

    it('releases advisory lock even when migration throws', async () => {
      const { mockPool, mockClient } = createMockPool();
      const migrationError = new Error('migration failed');
      mockMigrateToLatest.mockResolvedValue({ results: [], error: migrationError });

      await expect(runMigrations({ db: createMockDb(), pool: mockPool as any })).rejects.toThrow(
        'migration failed',
      );

      // Lock must still be released
      expect(mockClient.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [543210001]);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('returns applied migration results', async () => {
      const { mockPool } = createMockPool();
      const results = [
        { migrationName: '001_initial', status: 'Success' as const, direction: 'Up' as const },
        { migrationName: '002_add_sources', status: 'Success' as const, direction: 'Up' as const },
      ];
      mockMigrateToLatest.mockResolvedValue({ results, error: undefined });

      const actual = await runMigrations({ db: createMockDb(), pool: mockPool as any });

      expect(actual).toEqual(results);
      expect(actual).toHaveLength(2);
    });

    it('returns empty array when schema is up to date', async () => {
      const { mockPool } = createMockPool();
      mockMigrateToLatest.mockResolvedValue({ results: [], error: undefined });

      const actual = await runMigrations({ db: createMockDb(), pool: mockPool as any });

      expect(actual).toEqual([]);
    });

    it('records the migration content hash after a successful migration', async () => {
      const { mockPool } = createMockPool();
      const results = [
        { migrationName: '002_add_sources', status: 'Success' as const, direction: 'Up' as const },
      ];
      mockMigrateToLatest.mockResolvedValue({ results, error: undefined });

      await runMigrations({ db: createMockDb(), pool: mockPool as any });

      expect(mockComputeMigrationsHash).toHaveBeenCalledOnce();
      expect(mockStoreMigrationContentHash).toHaveBeenCalledWith(mockPool, 'deadbeef');
    });

    it('records the content hash even when no migrations are applied (warm DB)', async () => {
      // Reproduces the bug: a warm DB whose migrations are all applied but
      // whose _migration_content_hash row is absent must still get the hash
      // written so `check-schema` reports current.
      const { mockPool } = createMockPool();
      mockMigrateToLatest.mockResolvedValue({ results: [], error: undefined });

      await runMigrations({ db: createMockDb(), pool: mockPool as any });

      expect(mockComputeMigrationsHash).toHaveBeenCalledOnce();
      expect(mockStoreMigrationContentHash).toHaveBeenCalledWith(mockPool, 'deadbeef');
    });

    it('does not record the content hash when the migration fails', async () => {
      const { mockPool } = createMockPool();
      mockMigrateToLatest.mockResolvedValue({ results: [], error: new Error('boom') });

      await expect(runMigrations({ db: createMockDb(), pool: mockPool as any })).rejects.toThrow(
        'boom',
      );

      expect(mockStoreMigrationContentHash).not.toHaveBeenCalled();
    });
  });

  describe('migrateTo', () => {
    /** The names the hash provider was handed, in whatever order it built them. */
    async function hashedNames(): Promise<string[]> {
      const provider = mockComputeMigrationsHash.mock.calls.at(-1)?.[0] as {
        getMigrations(): Promise<Record<string, unknown>>;
      };
      return Object.keys(await provider.getMigrations()).sort();
    }

    it('hashes only the migrations the ledger still records after a revert', async () => {
      // The stored hash is compared against a hash of the binary's WHOLE
      // migration set, so hashing the whole set here would make
      // `db check-schema` report "current" on a database deliberately rolled
      // back to an earlier head.
      const { mockPool } = createMockPool();
      mockMigrateTo.mockResolvedValue({
        results: [
          {
            migrationName: '002_add_sources',
            status: 'Success' as const,
            direction: 'Down' as const,
          },
        ],
        error: undefined,
      });
      mockGetMigrations.mockResolvedValue([
        { name: '001_initial', executedAt: new Date() },
        { name: '002_add_sources', executedAt: undefined },
      ]);

      const result = await migrateTo({ db: createMockDb(), pool: mockPool as any }, '001_initial');

      expect(result).toEqual({ target: '001_initial', applied: [], reverted: ['002_add_sources'] });
      expect(await hashedNames()).toEqual(['001_initial']);
    });

    it('hashes the whole set once every migration is applied again', async () => {
      const { mockPool } = createMockPool();
      mockMigrateTo.mockResolvedValue({
        results: [
          {
            migrationName: '002_add_sources',
            status: 'Success' as const,
            direction: 'Up' as const,
          },
        ],
        error: undefined,
      });
      mockGetMigrations.mockResolvedValue([
        { name: '001_initial', executedAt: new Date() },
        { name: '002_add_sources', executedAt: new Date() },
      ]);

      await migrateTo({ db: createMockDb(), pool: mockPool as any }, '002_add_sources');

      expect(await hashedNames()).toEqual(['001_initial', '002_add_sources']);
    });

    it('refuses a migration this binary does not carry', async () => {
      const { mockPool } = createMockPool();

      await expect(
        migrateTo({ db: createMockDb(), pool: mockPool as any }, '999_nope'),
      ).rejects.toThrow('unknown migration "999_nope"');
      expect(mockStoreMigrationContentHash).not.toHaveBeenCalled();
    });
  });

  describe('getMigrationStatus', () => {
    it('returns applied status for executed migrations', async () => {
      const now = new Date();
      mockGetMigrations.mockResolvedValue([
        { name: '001_initial', executedAt: now },
        { name: '002_add_sources', executedAt: now },
      ]);

      const { mockPool } = createMockPool();
      const status = await getMigrationStatus({ db: createMockDb(), pool: mockPool as any });

      expect(status).toEqual([
        { name: '001_initial', status: 'applied', appliedAt: now },
        { name: '002_add_sources', status: 'applied', appliedAt: now },
      ]);
    });

    it('returns pending status for unexecuted migrations', async () => {
      mockGetMigrations.mockResolvedValue([
        { name: '001_initial', executedAt: undefined },
        { name: '002_add_sources', executedAt: undefined },
      ]);

      const { mockPool } = createMockPool();
      const status = await getMigrationStatus({ db: createMockDb(), pool: mockPool as any });

      expect(status).toEqual([
        { name: '001_initial', status: 'pending', appliedAt: undefined },
        { name: '002_add_sources', status: 'pending', appliedAt: undefined },
      ]);
    });

    it('returns mixed applied and pending states', async () => {
      const now = new Date();
      mockGetMigrations.mockResolvedValue([
        { name: '001_initial', executedAt: now },
        { name: '002_add_sources', executedAt: undefined },
      ]);

      const { mockPool } = createMockPool();
      const status = await getMigrationStatus({ db: createMockDb(), pool: mockPool as any });

      expect(status).toEqual([
        { name: '001_initial', status: 'applied', appliedAt: now },
        { name: '002_add_sources', status: 'pending', appliedAt: undefined },
      ]);
    });
  });
});

describe('migration pool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the migration pool with no statement timeout', () => {
    mockCreatePool.mockReturnValue({ end: vi.fn() });

    createMigrationPool('postgres://example/kici');

    expect(mockCreatePool).toHaveBeenCalledWith('postgres://example/kici', {
      config: { max: 2, statement_timeout: 0 },
    });
  });

  it('destroys the Kysely instance once the callback settles', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mockCreatePool.mockReturnValue({ end: vi.fn() });
    mockCreateDb.mockReturnValue({ destroy });

    const seen = await withMigrationPool('postgres://example/kici', async (opts) => {
      expect(destroy).not.toHaveBeenCalled();
      return opts;
    });

    expect(seen.pool).toBeDefined();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the Kysely instance when the callback throws', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    mockCreatePool.mockReturnValue({ end: vi.fn() });
    mockCreateDb.mockReturnValue({ destroy });

    await expect(
      withMigrationPool('postgres://example/kici', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('migration failure diagnostics', () => {
  it('recognises a cancelled statement', () => {
    expect(isStatementTimeoutError('canceling statement due to statement timeout')).toBe(true);
    expect(isStatementTimeoutError('relation "foo" does not exist')).toBe(false);
  });

  it('names the migration that failed', () => {
    expect(describeMigrationFailure('relation "foo" does not exist', '113_widget_index')).toBe(
      'migration 113_widget_index failed: relation "foo" does not exist',
    );
  });

  it('adds the escape hatch on a cancelled statement', () => {
    const described = describeMigrationFailure(
      'canceling statement due to statement timeout',
      '098_execution_runs_customer_id',
    );
    expect(described).toContain('098_execution_runs_customer_id');
    expect(described).toContain('KICI_DB_STATEMENT_TIMEOUT_MS=0');
    expect(described).toContain('kici-admin db migrate');
  });

  it('still reads sensibly when no migration name is known', () => {
    expect(describeMigrationFailure('corrupted migrations')).toBe(
      'migration failed: corrupted migrations',
    );
  });
});

describe('runMigrations failure reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeMigrationsHash.mockResolvedValue('deadbeef');
    mockStoreMigrationContentHash.mockResolvedValue(undefined);
  });

  it('rethrows with the failing migration named and the timeout hint attached', async () => {
    const { mockPool } = createMockPool();
    const cause = new Error('canceling statement due to statement timeout');
    mockMigrateToLatest.mockResolvedValue({
      results: [
        { migrationName: '097_earlier', direction: 'Up', status: 'Success' },
        { migrationName: '098_execution_runs_customer_id', direction: 'Up', status: 'Error' },
      ],
      error: cause,
    });

    await expect(runMigrations({ db: createMockDb(), pool: mockPool as any })).rejects.toThrow(
      /098_execution_runs_customer_id.*KICI_DB_STATEMENT_TIMEOUT_MS=0/s,
    );
  });

  it('preserves the driver error as the cause', async () => {
    const { mockPool } = createMockPool();
    const cause = new Error('relation "foo" does not exist');
    mockMigrateToLatest.mockResolvedValue({
      results: [{ migrationName: '113_widget_index', direction: 'Up', status: 'Error' }],
      error: cause,
    });

    await expect(
      runMigrations({ db: createMockDb(), pool: mockPool as any }),
    ).rejects.toMatchObject({ cause });
  });
});
