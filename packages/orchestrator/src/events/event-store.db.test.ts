import { beforeAll, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { EventStore } from './event-store.js';
import { DEFAULT_EVENT_ROUTER_CONFIG, EventMatchOutcome } from './types.js';

/**
 * Real-Postgres coverage for `EventStore.list` paging. `created_at` is stored
 * with microseconds while a JavaScript `Date` keeps milliseconds, so a cursor
 * built from a row's `Date` would skip the rows that share its millisecond.
 * The cursor is an event id compared on the stored `(created_at, id)` instead.
 */
describeWithTestDb<Database>(
  'EventStore.list against Postgres',
  { prefix: 'kici_evlist_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

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
  },
);
