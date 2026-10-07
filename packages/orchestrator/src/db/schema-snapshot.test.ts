import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { diffFingerprints, fingerprintSchema, renderSnapshotModule } from '@kici-dev/shared';
import { createDb } from './client.js';
import { runMigrations } from './migrator.js';
import { DEFERRED_INDEXES } from './deferred-indexes.js';
import { SCHEMA_SNAPSHOT } from './schema-snapshot.generated.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';

/**
 * The schema the migrations build must equal the committed snapshot. The
 * `kici-admin db schema-diff` command compares live databases against the
 * same snapshot, so a migration that changes the schema without regenerating
 * it fails here first. Regenerate with:
 *   KICI_UPDATE_SCHEMA_SNAPSHOT=1 pnpm --filter @kici-dev/orchestrator exec vitest run src/db/schema-snapshot.test.ts
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_schema_snapshot_${process.pid}_${Date.now()}`;
const SNAPSHOT_PATH = new URL('./schema-snapshot.generated.ts', import.meta.url);

describeDb('orchestrator schema snapshot', () => {
  let pool: pg.Pool;
  let db: Kysely<unknown>;

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
    db = createDb(pool) as unknown as Kysely<unknown>;
    await runMigrations({ db, pool });
  }, 180_000);

  afterAll(async () => {
    await db?.destroy();
    const admin = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('matches the committed snapshot', async () => {
    // fails-when: a migration changes the schema and the snapshot was not regenerated.
    const live = await fingerprintSchema(pool, {
      excludeIndexes: DEFERRED_INDEXES.map((i) => i.name),
    });
    if (process.env.KICI_UPDATE_SCHEMA_SNAPSHOT === '1') {
      writeFileSync(SNAPSHOT_PATH, renderSnapshotModule(live, 'src/db/schema-snapshot.test.ts'));
      return;
    }
    expect(diffFingerprints(SCHEMA_SNAPSHOT, live)).toEqual([]);
    // The diff ignores an extension only the live database has, so a migration
    // that adds one is caught here instead.
    expect(live.extensions).toEqual(SCHEMA_SNAPSHOT.extensions);
  });

  it('does not count a built deferred index as drift', async () => {
    // fails-when: the deferred indexes are compared, so every live DB reports drift.
    // breaks-if-wrong: excluding by name must not hide an index a migration builds.
    const [first] = DEFERRED_INDEXES;
    await pool.query(first.sql);
    const live = await fingerprintSchema(pool, {
      excludeIndexes: DEFERRED_INDEXES.map((i) => i.name),
    });
    expect(diffFingerprints(SCHEMA_SNAPSHOT, live)).toEqual([]);
    const unfiltered = await fingerprintSchema(pool);
    expect(diffFingerprints(SCHEMA_SNAPSHOT, unfiltered).map((e) => e.path)).toContain(
      `indexes:${first.name}`,
    );
  });
});
