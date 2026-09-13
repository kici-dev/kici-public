import { describe, expect, it, vi } from 'vitest';
import {
  DEFERRED_INDEXES,
  DEFERRED_INDEX_LOCK_KEY,
  buildDeferredIndexes,
  dropIfInvalid,
} from './deferred-indexes.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

/** A fake `pg` module whose Client records every statement it is handed. */
function fakeDriver(opts?: { lockGranted?: boolean; invalid?: string[]; failOn?: string }) {
  const statements: string[] = [];
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('pg_try_advisory_lock')) {
        expect(params).toEqual([DEFERRED_INDEX_LOCK_KEY]);
        return { rows: [{ locked: opts?.lockGranted ?? true }] };
      }
      if (sql.includes('indisvalid')) {
        return { rows: [{ invalid: (opts?.invalid ?? []).includes(String(params?.[0])) }] };
      }
      if (opts?.failOn && sql.includes(opts.failOn)) throw new Error('index build failed');
      return { rows: [] };
    }),
  };
  const ctor = vi.fn(function () {
    return client;
  });
  return { driver: { Client: ctor } as any, client, ctor, statements };
}

const oneIndex = [
  { name: 'demo_idx', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS demo_idx ON t (c)' },
];

describe('DEFERRED_INDEXES', () => {
  it('builds every index concurrently and idempotently', () => {
    for (const index of DEFERRED_INDEXES) {
      expect(index.sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
      expect(index.sql).toContain(index.name);
    }
  });

  it('uses a lock key distinct from the migrator, so neither blocks the other', () => {
    expect(DEFERRED_INDEX_LOCK_KEY).not.toBe(543210001);
  });

  it('covers the unindexed execution_runs self-FK the retention delete triggers', () => {
    // Without it every DELETE of a run runs the referencing-side FK check as a
    // sequential scan, once per deleted row, and the batch is cancelled by the
    // serving pool's statement timeout before it can finish.
    const fk = DEFERRED_INDEXES.find((i) => i.name === 'execution_runs_parent_run_id_idx');
    expect(fk, 'expected an index on execution_runs.parent_run_id').toBeDefined();
    expect(fk!.sql).toMatch(/execution_runs\s+USING btree \(parent_run_id\)/);
  });
});

describe('buildDeferredIndexes', () => {
  it('connects with no statement timeout', async () => {
    const { driver, ctor } = fakeDriver();
    await buildDeferredIndexes('postgres://example/kici', {
      logger,
      indexes: oneIndex,
      pg: driver,
    });
    expect(ctor).toHaveBeenCalledWith({
      connectionString: 'postgres://example/kici',
      statement_timeout: 0,
    });
  });

  it('builds each index and releases the advisory lock', async () => {
    const { driver, statements } = fakeDriver();
    const result = await buildDeferredIndexes('postgres://x/y', {
      logger,
      indexes: oneIndex,
      pg: driver,
    });
    expect(result).toEqual({ built: ['demo_idx'], failed: [] });
    expect(statements.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('skips entirely when a peer holds the lock', async () => {
    const { driver, statements } = fakeDriver({ lockGranted: false });
    const result = await buildDeferredIndexes('postgres://x/y', {
      logger,
      indexes: oneIndex,
      pg: driver,
    });
    expect(result).toEqual({ built: [], failed: [] });
    expect(statements.some((s) => s.includes('CREATE INDEX'))).toBe(false);
  });

  it('records a failed build and keeps going', async () => {
    const { driver } = fakeDriver({ failOn: 'second_idx' });
    const result = await buildDeferredIndexes('postgres://x/y', {
      logger,
      pg: driver,
      indexes: [
        { name: 'first_idx', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS first_idx ON t (c)' },
        { name: 'second_idx', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS second_idx ON t (c)' },
        { name: 'third_idx', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS third_idx ON t (c)' },
      ],
    });
    expect(result.built).toEqual(['first_idx', 'third_idx']);
    expect(result.failed).toEqual(['second_idx']);
  });

  it('releases the lock even when a build throws', async () => {
    const { driver, statements } = fakeDriver({ failOn: 'demo_idx' });
    await buildDeferredIndexes('postgres://x/y', { logger, indexes: oneIndex, pg: driver });
    expect(statements.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('drops a leftover invalid index before rebuilding, so a retry is not a no-op', async () => {
    const { driver, statements } = fakeDriver({ invalid: ['demo_idx'] });
    await buildDeferredIndexes('postgres://x/y', { logger, indexes: oneIndex, pg: driver });
    const dropIdx = statements.findIndex((s) => s.includes('DROP INDEX CONCURRENTLY'));
    const buildIdx = statements.findIndex((s) => s.includes('CREATE INDEX CONCURRENTLY'));
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeLessThan(buildIdx);
  });

  it('does nothing at all when the registry is empty', async () => {
    const { driver, ctor } = fakeDriver();
    const result = await buildDeferredIndexes('postgres://x/y', {
      logger,
      indexes: [],
      pg: driver,
    });
    expect(result).toEqual({ built: [], failed: [] });
    expect(ctor).not.toHaveBeenCalled();
  });
});

describe('dropIfInvalid', () => {
  it('leaves a valid index alone', async () => {
    const query = vi.fn(async () => ({ rows: [{ invalid: false }] }));
    await dropIfInvalid({ query } as any, 'demo_idx', logger);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('leaves an absent index alone', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await dropIfInvalid({ query } as any, 'demo_idx', logger);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
