import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { EventStore } from './event-store.js';
import { DEFAULT_EVENT_ROUTER_CONFIG, EventMatchOutcome } from './types.js';

/**
 * Real-Postgres coverage for `EventStore.list` paging. `created_at` is stored
 * with microseconds while a JavaScript `Date` keeps milliseconds, so a cursor
 * built from a row's `Date` would skip the rows that share its millisecond.
 * The cursor is an event id compared on the stored `(created_at, id)` instead.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_evlist_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('EventStore.list against Postgres', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('pages through events that share a millisecond without skipping or repeating one', async () => {
    // Five events inside one millisecond, distinct only in microseconds.
    for (let us = 1; us <= 5; us++) {
      await sql`INSERT INTO kici_events (event_name, payload, chain_depth, created_at, expires_at)
                VALUES ('kici.scaler.scale-up', '{}'::jsonb, 0,
                        ${`2026-10-01T10:00:00.123${String(us).padStart(3, '0')}Z`}::timestamptz,
                        now() + interval '1 day')`.execute(db);
    }
    const store = new EventStore(db, DEFAULT_EVENT_ROUTER_CONFIG);
    const all = await store.list({ limit: 50 });
    expect(all).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await store.list({ limit: 2, ...(cursor && { afterEventId: cursor }) });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      cursor = rows[rows.length - 1]!.id;
    }
    // fails-when: the cursor compares on a millisecond Date — the second page
    // is empty because every remaining row shares the first page's millisecond.
    expect(seen).toEqual(all.map((r) => r.id));
    // Positive control for the premise: a millisecond Date taken from a row
    // reads every row of that millisecond as "not before", so a Date cursor
    // after the first page would have returned nothing.
    expect(await store.list({ limit: 50, before: all[1]!.createdAt })).toEqual([]);
  });

  it('filters by name and match outcome', async () => {
    const ids = await sql<{ id: string }>`
      INSERT INTO kici_events (event_name, payload, chain_depth, expires_at, processed,
                               match_outcome, matched_count)
      VALUES ('deploy-done', '{}'::jsonb, 0, now() + interval '1 day', true, 'matched', 1),
             ('deploy-done', '{}'::jsonb, 0, now() + interval '1 day', true, 'no-target-repo', 0)
      RETURNING id`.execute(db);
    const store = new EventStore(db, DEFAULT_EVENT_ROUTER_CONFIG);
    const rows = await store.list({
      limit: 10,
      name: 'deploy-done',
      outcome: EventMatchOutcome.enum['no-target-repo'],
    });
    expect(rows.map((r) => r.id)).toEqual([ids.rows[1]!.id]);
    expect(rows[0]!.matchOutcome).toBe(EventMatchOutcome.enum['no-target-repo']);
    expect(rows[0]!.matchedCount).toBe(0);
  });
});
