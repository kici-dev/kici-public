import { beforeAll, expect, it } from 'vitest';
import type pg from 'pg';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { analyzeTables, getGinTableStatsReport, resolveAnalyzeTargets } from './db-stats.js';

// Real-Postgres proof that stats-check reads the catalog the way the
// PostgreSQL 18.6 release note describes, and that ANALYZE heals a bad value.
// Gated on KICI_TEST_ADMIN_DATABASE_URL. The test user is a superuser, which
// may write pg_class directly to plant the corrupt value a parallel GIN build
// leaves behind.
describeWithTestDb('db stats-check (real Postgres)', { prefix: 'kici_db_stats' }, (getDb) => {
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ pool } = getDb());
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`CREATE TABLE gin_t (id int PRIMARY KEY, body text NOT NULL)`);
    await pool.query(`INSERT INTO gin_t SELECT g, 'row ' || g FROM generate_series(1, 500) g`);
    await pool.query(`CREATE INDEX gin_t_body_trgm ON gin_t USING gin (body gin_trgm_ops)`);
    // A table with only a b-tree index stays out of the report even when broken.
    await pool.query(`CREATE TABLE btree_t (id int PRIMARY KEY)`);
    await pool.query(`ANALYZE gin_t`);
    await pool.query(`ANALYZE btree_t`);
  }, 60_000);

  async function setRelTuples(table: string, value: string): Promise<void> {
    await pool.query(`UPDATE pg_class SET reltuples = $1::real WHERE oid = $2::regclass`, [
      value,
      table,
    ]);
  }

  it('reports a healthy GIN table as clean (the positive control)', async () => {
    // breaks-if-wrong: a correctly analyzed table must not be flagged, or every
    // healthy database exits 2.
    const report = await getGinTableStatsReport(pool);
    expect(report.tables.map((t) => t.table)).toEqual(['public.gin_t']);
    expect(report.tables[0]).toMatchObject({
      ginIndexes: ['gin_t_body_trgm'],
      reltuples: '500',
      problem: null,
    });
    expect(report.clean).toBe(true);
  });

  it.each([
    ['NaN', 'nan'],
    ['Infinity', 'infinite'],
    ['-Infinity', 'infinite'],
    ['1e30', 'exceeds_page_capacity'],
  ])('reports reltuples=%s as %s, and ANALYZE heals it', async (bad, problem) => {
    // fails-when: the catalog query misses GIN indexes, or a planted bad value
    // reads back as a sane one.
    await setRelTuples('gin_t', bad);
    await setRelTuples('btree_t', bad);
    const broken = await getGinTableStatsReport(pool);
    expect(broken.clean).toBe(false);
    expect(broken.needsAnalyze).toEqual(['public.gin_t']);
    expect(broken.tables[0]!.problem).toBe(problem);

    const targets = await resolveAnalyzeTargets(pool, ['public.gin_t', 'public.btree_t']);
    await analyzeTables(pool, targets);

    const healed = await getGinTableStatsReport(pool);
    expect(healed.clean).toBe(true);
    expect(healed.tables[0]!.reltuples).toBe('500');
  });

  it('refuses a table that does not exist, and an index name', async () => {
    await expect(resolveAnalyzeTargets(pool, ['public.no_such_table'])).rejects.toThrow(
      /Unknown table\(s\): public\.no_such_table/,
    );
    await expect(resolveAnalyzeTargets(pool, ['public.gin_t_body_trgm'])).rejects.toThrow(
      /Unknown table/,
    );
  });
});
