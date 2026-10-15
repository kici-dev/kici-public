import { writeFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { diffFingerprints, fingerprintSchema, renderSnapshotModule } from '@kici-dev/shared';
import { runMigrations } from './migrator.js';
import { DEFERRED_INDEXES } from './deferred-indexes.js';
import { SCHEMA_SNAPSHOT } from './schema-snapshot.generated.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

const SNAPSHOT_PATH = new URL('./schema-snapshot.generated.ts', import.meta.url);

/**
 * The schema the migrations build must equal the committed snapshot. The
 * `kici-admin db schema-diff` command compares live databases against the
 * same snapshot, so a migration that changes the schema without regenerating
 * it fails here first. Regenerate with:
 *   KICI_UPDATE_SCHEMA_SNAPSHOT=1 pnpm --filter @kici-dev/orchestrator exec vitest run src/db/schema-snapshot.test.ts
 */
describeWithTestDb<unknown>(
  'orchestrator schema snapshot',
  { prefix: 'kici_schema_snapshot', timeoutMs: 180_000 },
  (getDb) => {
    let pool: pg.Pool;
    let db: Kysely<unknown>;

    beforeAll(async () => {
      ({ db, pool } = getDb());
      await runMigrations({ db, pool });
    }, 180_000);

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
  },
);
