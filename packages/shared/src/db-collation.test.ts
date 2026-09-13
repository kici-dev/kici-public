import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  checkCollationDriftAtStartup,
  collationDriftRemediation,
  FAIL_ON_COLLATION_DRIFT_ENV,
  getDatabaseCollationDrift,
  refreshDatabaseCollationVersion,
  reindexDatabaseConcurrently,
  shouldFailOnCollationDrift,
} from './db-collation.js';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(): MockPool {
  return { query: vi.fn() };
}

describe('getDatabaseCollationDrift', () => {
  it('returns null when stamped and actual match', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: '2.41', actual: '2.41' }] });
    const drift = await getDatabaseCollationDrift(pool as unknown as pg.Pool, 'platform');
    expect(drift).toBeNull();
    expect(pool.query).toHaveBeenCalledOnce();
    const args = pool.query.mock.calls[0];
    expect(args[0]).toMatch(/datcollversion AS stamped/);
    expect(args[0]).toMatch(/pg_database_collation_actual_version/);
    expect(args[1]).toEqual(['platform']);
  });

  it('returns null when stamped is null (template0-style locked DBs)', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: null, actual: '2.41' }] });
    const drift = await getDatabaseCollationDrift(pool as unknown as pg.Pool, 'template0');
    expect(drift).toBeNull();
  });

  it('returns the drift object when stamped and actual differ', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: '2.35', actual: '2.41' }] });
    const drift = await getDatabaseCollationDrift(pool as unknown as pg.Pool, 'platform');
    expect(drift).toEqual({ stamped: '2.35', actual: '2.41' });
  });

  it('throws when the database row is missing', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [] });
    await expect(
      getDatabaseCollationDrift(pool as unknown as pg.Pool, 'no-such-db'),
    ).rejects.toThrow(/database not found/);
  });

  it('propagates pool.query rejection', async () => {
    const pool = makePool();
    const err = new Error('connection refused');
    pool.query.mockRejectedValue(err);
    await expect(getDatabaseCollationDrift(pool as unknown as pg.Pool, 'platform')).rejects.toBe(
      err,
    );
  });
});

describe('reindexDatabaseConcurrently', () => {
  it('issues REINDEX DATABASE CONCURRENTLY with the identifier properly quoted', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [] });
    await reindexDatabaseConcurrently(pool as unknown as pg.Pool, 'platform');
    expect(pool.query).toHaveBeenCalledExactlyOnceWith('REINDEX DATABASE CONCURRENTLY "platform"');
  });

  it('escapes double-quotes in the database identifier', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [] });
    await reindexDatabaseConcurrently(pool as unknown as pg.Pool, 'we"ird');
    expect(pool.query).toHaveBeenCalledExactlyOnceWith('REINDEX DATABASE CONCURRENTLY "we""ird"');
  });

  it('propagates pool.query rejection', async () => {
    const pool = makePool();
    const err = new Error('reindex failed: concurrent index build aborted');
    pool.query.mockRejectedValue(err);
    await expect(reindexDatabaseConcurrently(pool as unknown as pg.Pool, 'platform')).rejects.toBe(
      err,
    );
  });
});

describe('refreshDatabaseCollationVersion', () => {
  it('issues ALTER DATABASE REFRESH COLLATION VERSION with the identifier properly quoted', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [] });
    await refreshDatabaseCollationVersion(pool as unknown as pg.Pool, 'platform');
    expect(pool.query).toHaveBeenCalledExactlyOnceWith(
      'ALTER DATABASE "platform" REFRESH COLLATION VERSION',
    );
  });

  it('escapes double-quotes in the database identifier', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [] });
    await refreshDatabaseCollationVersion(pool as unknown as pg.Pool, 'we"ird');
    expect(pool.query).toHaveBeenCalledExactlyOnceWith(
      'ALTER DATABASE "we""ird" REFRESH COLLATION VERSION',
    );
  });

  it('propagates pool.query rejection', async () => {
    const pool = makePool();
    const err = new Error('refresh collation version: insufficient privilege');
    pool.query.mockRejectedValue(err);
    await expect(
      refreshDatabaseCollationVersion(pool as unknown as pg.Pool, 'platform'),
    ).rejects.toBe(err);
  });
});

describe('collationDriftRemediation', () => {
  it('renders both heal steps with the identifier quoted', () => {
    expect(collationDriftRemediation('platform')).toBe(
      'REINDEX DATABASE CONCURRENTLY "platform"; ALTER DATABASE "platform" REFRESH COLLATION VERSION;',
    );
  });

  it('escapes double-quotes in the database identifier', () => {
    expect(collationDriftRemediation('we"ird')).toBe(
      'REINDEX DATABASE CONCURRENTLY "we""ird"; ALTER DATABASE "we""ird" REFRESH COLLATION VERSION;',
    );
  });
});

describe('shouldFailOnCollationDrift', () => {
  it('is true only when the env var is exactly "true"', () => {
    expect(shouldFailOnCollationDrift({ [FAIL_ON_COLLATION_DRIFT_ENV]: 'true' })).toBe(true);
    expect(shouldFailOnCollationDrift({ [FAIL_ON_COLLATION_DRIFT_ENV]: '1' })).toBe(false);
    expect(shouldFailOnCollationDrift({ [FAIL_ON_COLLATION_DRIFT_ENV]: 'TRUE' })).toBe(false);
    expect(shouldFailOnCollationDrift({})).toBe(false);
  });
});

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

interface MockLogger {
  info: ReturnType<typeof vi.fn<LogFn>>;
  warn: ReturnType<typeof vi.fn<LogFn>>;
  error: ReturnType<typeof vi.fn<LogFn>>;
}

function makeLogger(): MockLogger {
  return { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

describe('checkCollationDriftAtStartup', () => {
  it('logs info and returns null on a clean DB', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: '2.41', actual: '2.41' }] });
    const logger = makeLogger();

    const drift = await checkCollationDriftAtStartup(
      pool as unknown as pg.Pool,
      'platform',
      logger,
    );

    expect(drift).toBeNull();
    expect(logger.info).toHaveBeenCalledWith('Database collation version is consistent', {
      database: 'platform',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a loud structured ERROR on drift and returns it (no throw by default)', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: '2.35', actual: '2.41' }] });
    const logger = makeLogger();

    const drift = await checkCollationDriftAtStartup(pool as unknown as pg.Pool, 'kici', logger);

    expect(drift).toEqual({ stamped: '2.35', actual: '2.41' });
    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0][0];
    const meta = logger.error.mock.calls[0][1] as Record<string, unknown>;
    expect(message).toMatch(/collation drift detected/i);
    expect(meta).toMatchObject({
      database: 'kici',
      stampedCollationVersion: '2.35',
      actualCollationVersion: '2.41',
      risk: 'corrupted-text-btree-index',
    });
    expect(meta.remediation).toBe(collationDriftRemediation('kici'));
  });

  it('throws after logging when failOnDrift is set', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: '2.35', actual: '2.41' }] });
    const logger = makeLogger();

    await expect(
      checkCollationDriftAtStartup(pool as unknown as pg.Pool, 'kici', logger, {
        failOnDrift: true,
      }),
    ).rejects.toThrow(new RegExp(FAIL_ON_COLLATION_DRIFT_ENV));
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('does not throw on drift when failOnDrift is false', async () => {
    const pool = makePool();
    pool.query.mockResolvedValue({ rows: [{ stamped: '2.35', actual: '2.41' }] });
    const logger = makeLogger();

    await expect(
      checkCollationDriftAtStartup(pool as unknown as pg.Pool, 'kici', logger, {
        failOnDrift: false,
      }),
    ).resolves.toEqual({ stamped: '2.35', actual: '2.41' });
  });

  it('logs a WARN and returns null when the probe query throws (never crashes boot)', async () => {
    const pool = makePool();
    pool.query.mockRejectedValue(new Error('connection refused'));
    const logger = makeLogger();

    const drift = await checkCollationDriftAtStartup(pool as unknown as pg.Pool, 'kici', logger, {
      failOnDrift: true,
    });

    expect(drift).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      database: 'kici',
      error: 'connection refused',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
