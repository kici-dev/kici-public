import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { scheduleTriggerKey } from '@kici-dev/engine';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './096_multi_schedule_cron_last_fired.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig096_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 096_multi_schedule_cron_last_fired', () => {
  let db: Kysely<Record<string, never>>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;
  const regId = '11111111-1111-1111-1111-111111111111';
  const cron = '0 9 * * 1';
  const tz = 'UTC';

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`).catch(() => {});
    await admin.end();
  }, 60_000);

  it('backfills schedule_key equal to scheduleTriggerKey() for an existing row', async () => {
    // Roll back 096 to the legacy single-column shape, seed a legacy row (no
    // schedule_key), then re-apply 096 and assert the backfill matches the helper.
    await down(db);

    await sql`
      INSERT INTO public.workflow_registrations
        (id, repo_identifier, workflow_name, lock_entry, trigger_types, customer_id)
      VALUES (
        ${regId}, 'e2e/mig096', 'wf',
        ${JSON.stringify({
          name: 'wf',
          triggers: [
            { _type: 'schedule', cronExpression: cron, timezone: tz },
            { _type: 'schedule', cronExpression: '0 18 * * 5', timezone: tz },
          ],
        })}::jsonb,
        ARRAY['schedule'], 'cust-mig096'
      )
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
    await sql`
      INSERT INTO public.cron_last_fired (registration_id, last_fired_at)
      VALUES (${regId}, NOW() - INTERVAL '1 hour')
    `.execute(db);

    await up(db);

    const r = await sql<{ schedule_key: string }>`
      SELECT schedule_key FROM public.cron_last_fired WHERE registration_id = ${regId}
    `.execute(db);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.schedule_key).toBe(scheduleTriggerKey(cron, tz));
  });

  it('has a composite primary key (registration_id, schedule_key)', async () => {
    const r = await sql<{ attname: string }>`
      SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'public.cron_last_fired'::regclass AND i.indisprimary
       ORDER BY a.attname
    `.execute(db);
    expect(r.rows.map((x) => x.attname)).toEqual(['registration_id', 'schedule_key']);
  });

  it('down() collapses tied last_fired_at rows and restores the single-column PK', async () => {
    // Two schedules of one registration can share an identical last_fired_at
    // (coinciding cron instants). The down() dedup must break the tie so
    // recreating PRIMARY KEY (registration_id) does not fail with a
    // duplicate-key error.
    const tieReg = '22222222-2222-2222-2222-222222222222';
    const fixed = '2026-01-01 09:00:00+00';
    await sql`
      INSERT INTO public.workflow_registrations
        (id, repo_identifier, workflow_name, lock_entry, trigger_types, customer_id)
      VALUES (
        ${tieReg}, 'e2e/mig096-tie', 'wf-tie',
        ${JSON.stringify({
          name: 'wf-tie',
          triggers: [
            { _type: 'schedule', cronExpression: '0 9 * * *', timezone: tz },
            { _type: 'schedule', cronExpression: '0 9 * * 1', timezone: tz },
          ],
        })}::jsonb,
        ARRAY['schedule'], 'cust-mig096'
      )
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
    await sql`
      INSERT INTO public.cron_last_fired (registration_id, schedule_key, last_fired_at)
      VALUES
        (${tieReg}, ${scheduleTriggerKey('0 9 * * *', tz)}, ${fixed}::timestamptz),
        (${tieReg}, ${scheduleTriggerKey('0 9 * * 1', tz)}, ${fixed}::timestamptz)
    `.execute(db);

    // Must not throw duplicate-key when recreating PRIMARY KEY (registration_id).
    await down(db);

    const rows = await sql<{ registration_id: string }>`
      SELECT registration_id FROM public.cron_last_fired WHERE registration_id = ${tieReg}
    `.execute(db);
    expect(rows.rows).toHaveLength(1);

    await up(db); // restore composite shape for test isolation
  });
});
