import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they're available to vi.mock factories
const mockMigrateToLatest = vi.fn();
const mockGetMigrations = vi.fn();

vi.mock('kysely/migration', () => ({
  Migrator: class MockMigrator {
    constructor() {
      // no-op
    }
    migrateToLatest = mockMigrateToLatest;
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

vi.mock('@kici-dev/shared', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  computeMigrationsHash: (...args: unknown[]) => mockComputeMigrationsHash(...args),
  storeMigrationContentHash: (...args: unknown[]) => mockStoreMigrationContentHash(...args),
}));

// Import after mocks are set up
const { runMigrations, getMigrationStatus } = await import('./migrator.js');

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
