import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { terminateTestDbBackends } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 140, the `dispatch_queue` label fold.
 *
 * A DATA migration, so the test straddles it: `migrateToOwnMigration()` alone leaves no window
 * to insert rows, and assertions on rows 140 never saw pass with the body deleted. The suite
 * migrates to 139, inserts the rows an upgraded database holds, then migrates to 140.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig140_test_${process.pid}_${Date.now()}`;
const TARGET_MIGRATION = '140_dispatch_queue_canonical_labels';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 140_dispatch_queue_canonical_labels', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  let preFoldMixed: { runs_on_labels: unknown; exclude_labels: unknown };
  const adminUrl = ADMIN_URL!;

  /** Fills the NOT NULL columns `dispatch_queue` requires at 139; `job_name` is the read handle. */
  const insertRow = async (row: {
    jobName: string;
    runsOnLabels: string;
    excludeLabels: string | null;
    runsOnPatterns?: string;
    excludePatterns?: string;
  }): Promise<void> => {
    await sql`
      INSERT INTO public.dispatch_queue
        (run_id, workflow_name, job_name, runs_on_labels, exclude_labels,
         runs_on_patterns, exclude_patterns, job_config, repo_url, ref, sha,
         delivery_id, routing_key)
      VALUES ('run-140', 'mig140', ${row.jobName},
              ${row.runsOnLabels}::jsonb, ${row.excludeLabels}::jsonb,
              ${row.runsOnPatterns ?? '[]'}::jsonb, ${row.excludePatterns ?? '[]'}::jsonb,
              '{}', 'https://x/y', 'main', 'sha140', ${`d-${row.jobName}`}, 'rk-140')
    `.execute(db);
  };

  const readRow = async (
    jobName: string,
  ): Promise<{
    runs_on_labels: unknown;
    exclude_labels: unknown;
    runs_on_patterns: unknown;
    exclude_patterns: unknown;
  }> => {
    const r = await sql<{
      runs_on_labels: unknown;
      exclude_labels: unknown;
      runs_on_patterns: unknown;
      exclude_patterns: unknown;
    }>`
      SELECT runs_on_labels, exclude_labels, runs_on_patterns, exclude_patterns
        FROM public.dispatch_queue WHERE job_name = ${jobName}
    `.execute(db);
    const row = r.rows[0];
    if (row === undefined) throw new Error(`no dispatch_queue row named "${jobName}"`);
    return row;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

    // 1. The schema as it stood before this migration existed.
    const before = await migrateToPreviousMigration(db, import.meta.url);
    if (before.error) throw before.error;

    // 2. Rows an upgraded database holds, in whatever case the author used.
    await insertRow({
      jobName: 'mixed',
      runsOnLabels: JSON.stringify(['Docker', 'Linux']),
      excludeLabels: JSON.stringify(['Canary']),
    });
    await insertRow({
      jobName: 'canonical',
      runsOnLabels: JSON.stringify(['docker']),
      excludeLabels: JSON.stringify([]),
    });
    await insertRow({
      jobName: 'empty-exclude',
      runsOnLabels: JSON.stringify(['gpu']),
      excludeLabels: JSON.stringify([]),
    });
    await insertRow({
      jobName: 'padded',
      // Covers the whole trim set: spaces; tab and newline; vertical tab, carriage return and
      // form feed. A set omitting any leaves that label padded. `E'\v'` and `E'\x0B'` are the
      // same character in Postgres, so the label reads `kvm-v` under either TRIM_CHARS spelling.
      runsOnLabels: JSON.stringify([' Docker ', '\tARM64\n', '\u000B\rKVM-V\u000C']),
      excludeLabels: JSON.stringify([' Canary ']),
    });
    await insertRow({
      jobName: 'null-exclude',
      runsOnLabels: JSON.stringify(['GPU']),
      excludeLabels: null,
    });
    await insertRow({
      jobName: 'patterns',
      runsOnLabels: JSON.stringify(['Linux']),
      excludeLabels: JSON.stringify([]),
      runsOnPatterns: JSON.stringify(['^GPU-[A-Z]+$']),
      excludePatterns: JSON.stringify(['Canary-\\d+']),
    });

    // 2b. Pins the before/after pair: otherwise "the row is lowercase" also holds for a suite
    //     that inserted lowercase rows after the migration ran.
    preFoldMixed = await readRow('mixed');

    // 3. Only the migration under test. The harness throws when nothing applied, so a suite
    //    already at 140 before the inserts fails loudly.
    const after = await migrateToOwnMigration(db, import.meta.url);
    if (after.error) throw after.error;
    const applied = (after.results ?? []).map((r) => r.migrationName);
    if (applied.length !== 1 || applied[0] !== TARGET_MIGRATION) {
      throw new Error(
        `expected the straddle to apply exactly "${TARGET_MIGRATION}", applied ` +
          `[${applied.join(', ')}]`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('folds mixed-case labels on a row that predates the migration', async () => {
    // Mixed-case at 139 proves the straddle, so the folded values are 140's work. An emptied
    // `up()` leaves the pre-fold value and reddens the assertions below.
    expect(preFoldMixed.runs_on_labels).toEqual(['Docker', 'Linux']);
    expect(preFoldMixed.exclude_labels).toEqual(['Canary']);

    const row = await readRow('mixed');
    expect(row.runs_on_labels).toEqual(['docker', 'linux']);
    expect(row.exclude_labels).toEqual(['canary']);
  });

  it('leaves an already-canonical row unchanged', async () => {
    const row = await readRow('canonical');
    expect(row.runs_on_labels).toEqual(['docker']);
    expect(row.exclude_labels).toEqual([]);
  });

  it('preserves an empty exclude_labels array rather than nulling it', async () => {
    const row = await readRow('empty-exclude');
    // A negative control, not a COALESCE check: the `EXISTS` guard never admits an empty
    // array, so the row is skipped either way. It pins that the guard keeps skipping it; a
    // fold touching every row would have to get the empty case right, and fails here if not.
    expect(row.exclude_labels).toEqual([]);
    expect(row.exclude_labels).not.toBeNull();
  });

  it('trims surrounding whitespace so the fold matches canonicalizeLabel', async () => {
    const row = await readRow('padded');
    expect(row.runs_on_labels).toEqual(['docker', 'arm64', 'kvm-v']);
    expect(row.exclude_labels).toEqual(['canary']);
  });

  it('leaves a NULL exclude_labels as NULL', async () => {
    const row = await readRow('null-exclude');
    expect(row.runs_on_labels).toEqual(['gpu']);
    expect(row.exclude_labels).toBeNull();
  });

  it('does not touch the pattern columns, which hold regex sources', async () => {
    const row = await readRow('patterns');
    expect(row.runs_on_labels).toEqual(['linux']);
    // Lowercasing a regex source corrupts it: `[A-Z]` becomes `[a-z]` and
    // `\d` becomes a literal `d`. Patterns fold via the forced `i` flag on read.
    expect(row.runs_on_patterns).toEqual(['^GPU-[A-Z]+$']);
    expect(row.exclude_patterns).toEqual(['Canary-\\d+']);
  });

  it('is idempotent — re-running up() over folded rows changes nothing', async () => {
    const { up } = await import('./140_dispatch_queue_canonical_labels.js');
    await up(db);
    const row = await readRow('mixed');
    expect(row.runs_on_labels).toEqual(['docker', 'linux']);
    expect(row.exclude_labels).toEqual(['canary']);
  });
});
