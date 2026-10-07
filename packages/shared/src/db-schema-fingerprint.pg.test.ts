import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { diffFingerprints, fingerprintSchema } from './db-schema-fingerprint.js';

// Real-Postgres proof that the catalog queries see each object class.
// Gated on KICI_TEST_ADMIN_DATABASE_URL.
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_schema_fingerprint_${process.pid}_${Date.now()}`;

describeDb('fingerprintSchema (real Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${TEST_DB}`;
    pool = new pg.Pool({ connectionString: url.toString() });

    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`CREATE TABLE t (id int PRIMARY KEY, name text NOT NULL DEFAULT 'x')`);
    await pool.query(`CREATE INDEX t_name_idx ON t (name)`);
    await pool.query(
      `CREATE FUNCTION t_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER t_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION t_touch()`,
    );
    await pool.query(
      `CREATE TABLE kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255))`,
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('sees a table, its index, a trigger function and an extension, and skips tooling tables', async () => {
    // fails-when: a catalog query misses a class, or the tooling filter leaks.
    const fp = await fingerprintSchema(pool);
    expect(fp.columns['t.name']).toEqual({ type: 'text', nullable: false, default: "'x'::text" });
    expect(Object.keys(fp.indexes)).toEqual(expect.arrayContaining(['t_pkey', 't_name_idx']));
    // pg_trgm's own functions are extension members and stay out.
    expect(Object.keys(fp.functions)).toEqual(['t_touch()']);
    expect(Object.keys(fp.triggers)).toEqual(['t.t_touch']);
    expect(fp.extensions).toContain('pg_trgm');
    expect(fp.constraints['t.t_pkey']).toBe('p PRIMARY KEY (id)');
    // NOT NULL constraints are named after the column at creation time; the
    // column's `nullable` flag carries the fact instead. The catalog check is the
    // positive control: PostgreSQL 18 does store one for `t.name`.
    const notNull = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE contype = 'n' AND conrelid = 't'::regclass`,
    );
    expect(notNull.rowCount).toBeGreaterThan(0);
    expect(Object.values(fp.constraints).some((d) => d.startsWith('n '))).toBe(false);
    const tooling = [...Object.keys(fp.columns), ...Object.keys(fp.indexes)].filter((k) =>
      k.startsWith('kysely_migration'),
    );
    expect(tooling).toEqual([]);
  });

  it('skips excluded indexes (the runtime-built deferred indexes)', async () => {
    // fails-when: excludeIndexes is ignored — every live orchestrator DB would report drift.
    const withIndex = await fingerprintSchema(pool);
    const fp = await fingerprintSchema(pool, { excludeIndexes: ['t_name_idx'] });
    expect(fp.indexes).not.toHaveProperty('t_name_idx');
    expect(diffFingerprints(fp, withIndex)).toEqual([
      {
        path: 'indexes:t_name_idx',
        kind: 'extra',
        actual: withIndex.indexes.t_name_idx,
      },
    ]);
  });

  it('reports a nullability change through the column, not a NOT NULL constraint', async () => {
    // breaks-if-wrong: dropping NOT NULL constraints from the comparison must not hide
    // a nullability change — it moves into columns[*].nullable.
    const before = await fingerprintSchema(pool);
    await pool.query(`ALTER TABLE t ALTER COLUMN name DROP NOT NULL`);
    try {
      const after = await fingerprintSchema(pool);
      expect(diffFingerprints(before, after)).toEqual([
        {
          path: 'columns:t.name',
          kind: 'changed',
          expected: { type: 'text', nullable: false, default: "'x'::text" },
          actual: { type: 'text', nullable: true, default: "'x'::text" },
        },
      ]);
    } finally {
      await pool.query(`ALTER TABLE t ALTER COLUMN name SET NOT NULL`);
    }
  });
});
