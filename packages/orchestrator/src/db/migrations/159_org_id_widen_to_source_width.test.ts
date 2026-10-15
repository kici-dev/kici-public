import { beforeAll, describe, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { EventLogStatus } from '@kici-dev/engine';
import { migrateToOwnMigration, migrateToPreviousMigration } from '../migration-test-harness.js';
import { SCHEMA_SNAPSHOT } from '../schema-snapshot.generated.js';
import { down, up } from './159_org_id_widen_to_source_width.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 159. Seeds a Platform-format org id BEFORE the migration,
 * the way an upgraded database carries it, then asserts that an org id longer than 16
 * characters is stored and the existing row is untouched. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */

const ORG_ID_TABLES = [
  'access_log',
  'context_bindings',
  'context_source_overrides',
  'context_variables',
  'contexts',
  'event_log',
  'held_runs',
  'scoped_secrets',
];

/** A Platform org id: `org_` + a 12-character NanoID, exactly 16 characters. */
const PLATFORM_ORG_ID = 'org_abcdefghijkl';
/** The org id shape a standalone orchestrator's generic source carries (21 characters). */
const LONG_ORG_ID = 'e2e-win-1792059266967';

async function insertEventLogRow(db: Kysely<unknown>, orgId: string): Promise<void> {
  await sql`
    INSERT INTO public.event_log
      (org_id, delivery_id, routing_key, event, source, provider,
       payload_size_bytes, payload_hash, status)
    VALUES (${orgId}, ${`d-${orgId}`}, ${`generic:${orgId}:src`}, 'push', 'direct', 'generic',
            0, 'hash', ${EventLogStatus.enum.processed})
  `.execute(db);
}

/** `relfilenode` of every table under test and of each of its indexes. */
async function storageFiles(db: Kysely<unknown>): Promise<Record<string, string>> {
  const rows = await sql<{ relname: string; relfilenode: string }>`
    SELECT c.relname, c.relfilenode::text AS relfilenode
      FROM pg_class c
     WHERE c.oid IN (
             SELECT ('public.' || t)::regclass FROM unnest(${ORG_ID_TABLES}::text[]) AS t
           )
        OR c.oid IN (
             SELECT i.indexrelid FROM pg_index i
              WHERE i.indrelid IN (
                      SELECT ('public.' || t)::regclass FROM unnest(${ORG_ID_TABLES}::text[]) AS t
                    )
           )
  `.execute(db);
  return Object.fromEntries(rows.rows.map((r) => [r.relname, r.relfilenode]));
}

describe('every org_id column holds any org id a source can hold', () => {
  // A source's customer_id is the org id the generic webhook route and the event log carry,
  // so an org_id column narrower than it refuses an org the orchestrator already accepted.
  const columns = Object.entries(SCHEMA_SNAPSHOT.columns);
  const width = (type: string): number => {
    if (type === 'text') return Number.POSITIVE_INFINITY;
    const m = /^character varying\((\d+)\)$/.exec(type);
    return m ? Number(m[1]) : 0;
  };
  const sourceWidth = width(SCHEMA_SNAPSHOT.columns['generic_webhook_sources.customer_id'].type);
  const orgIdColumns = columns.filter(([name]) => name.endsWith('.org_id'));

  it('reads a bounded source width and finds the org_id columns', () => {
    // Positive control: the width parser reads the snapshot, and the filter is not empty.
    expect(sourceWidth).toBe(255);
    expect(orgIdColumns.map(([name]) => name)).toEqual(
      expect.arrayContaining(ORG_ID_TABLES.map((t) => `${t}.org_id`)),
    );
  });

  it.each(orgIdColumns.map(([name, col]) => [name, col.type]))(
    '%s (%s) is at least as wide as generic_webhook_sources.customer_id',
    (_name, type) => {
      // fails-when: a migration leaves or adds an org_id column narrower than the source width.
      expect(width(type)).toBeGreaterThanOrEqual(sourceWidth);
    },
  );
});

describeWithTestDb<unknown>(
  'migration 159_org_id_widen_to_source_width',
  { prefix: 'kici_mig159_test' },
  (getDb) => {
    let db: Kysely<unknown>;
    let filesBefore: Record<string, string>;
    let longIdRefusedBefore: string | null = null;

    beforeAll(async () => {
      db = getDb().db;
      const before = await migrateToPreviousMigration(db, import.meta.url);
      if (before.error) throw before.error;

      await insertEventLogRow(db, PLATFORM_ORG_ID);
      // The input this migration exists for, driven against the schema it replaces.
      try {
        await insertEventLogRow(db, LONG_ORG_ID);
      } catch (err) {
        longIdRefusedBefore = (err as Error).message;
      }
      filesBefore = await storageFiles(db);

      const after = await migrateToOwnMigration(db, import.meta.url);
      if (after.error) throw after.error;
    }, 60_000);

    it('refused the long org id before the migration', () => {
      // Positive control for the next test: the previous schema really rejects this input.
      expect(longIdRefusedBefore).toMatch(/value too long for type character varying\(16\)/);
    });

    it('widens org_id to varchar(255) on every table', async () => {
      const rows = await sql<{ table_name: string; data_type: string; len: number }>`
      SELECT table_name, data_type, character_maximum_length AS len
        FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'org_id'
         AND table_name = ANY(${ORG_ID_TABLES}::text[])
       ORDER BY table_name
    `.execute(db);
      expect(rows.rows).toEqual(
        [...ORG_ID_TABLES]
          .sort()
          .map((t) => ({ table_name: t, data_type: 'character varying', len: 255 })),
      );
    });

    it('stores an org id longer than 16 characters in the tables a standalone org writes', async () => {
      // fails-when: event_log.org_id is still varchar(16) — the insert throws "value too long".
      await insertEventLogRow(db, LONG_ORG_ID);
      await sql`INSERT INTO public.contexts (org_id, name) VALUES (${LONG_ORG_ID}, 'production')`.execute(
        db,
      );
      await sql`
      INSERT INTO public.scoped_secrets (org_id, scope, key, encrypted_value)
      VALUES (${LONG_ORG_ID}, 'org', 'TOKEN', 'ciphertext')
    `.execute(db);
      const found = await sql<{ n: string }>`
      SELECT (SELECT count(*) FROM public.event_log WHERE org_id = ${LONG_ORG_ID})
           + (SELECT count(*) FROM public.contexts WHERE org_id = ${LONG_ORG_ID})
           + (SELECT count(*) FROM public.scoped_secrets WHERE org_id = ${LONG_ORG_ID}) AS n
    `.execute(db);
      expect(Number(found.rows[0].n)).toBe(3);
    });

    it('keeps an existing Platform org id row as it was', async () => {
      // breaks-if-wrong: a row written before the upgrade must still match its org id.
      const rows = await sql<{ org_id: string }>`
      SELECT org_id FROM public.event_log WHERE org_id = ${PLATFORM_ORG_ID}
    `.execute(db);
      expect(rows.rows).toEqual([{ org_id: PLATFORM_ORG_ID }]);
    });

    it('rewrites no table and rebuilds no index', async () => {
      // fails-when: the ALTER rewrites a volume table (event_log, access_log) or rebuilds an
      // index, which holds the exclusive lock for the whole copy on a large database.
      expect(Object.keys(filesBefore)).toEqual(expect.arrayContaining(['event_log', 'access_log']));
      expect(await storageFiles(db)).toEqual(filesBefore);
    });

    it('is idempotent: a re-run on the widened schema succeeds', async () => {
      await expect(up(db)).resolves.toBeUndefined();
    });

    it('down refuses to truncate a long org id, then narrows once none remain', async () => {
      // breaks-if-wrong: a down that truncated would silently re-key rows to another org.
      await expect(down(db)).rejects.toThrow(/value too long/);
      await sql`DELETE FROM public.event_log WHERE org_id = ${LONG_ORG_ID}`.execute(db);
      await sql`DELETE FROM public.contexts WHERE org_id = ${LONG_ORG_ID}`.execute(db);
      await sql`DELETE FROM public.scoped_secrets WHERE org_id = ${LONG_ORG_ID}`.execute(db);
      await expect(down(db)).resolves.toBeUndefined();
      const rows = await sql<{ len: number }>`
      SELECT DISTINCT character_maximum_length AS len FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'org_id'
         AND table_name = ANY(${ORG_ID_TABLES}::text[])
    `.execute(db);
      expect(rows.rows).toEqual([{ len: 16 }]);
    });
  },
);
