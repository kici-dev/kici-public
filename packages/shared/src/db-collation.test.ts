import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import {
  getDatabaseCollationDrift,
  refreshDatabaseCollationVersion,
  reindexDatabaseConcurrently,
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
