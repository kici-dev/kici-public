import { type Kysely, sql } from 'kysely';

/**
 * Track cron last-fired per (registration, schedule) instead of per
 * registration, so a workflow with multiple schedule() triggers fires every
 * schedule — not just the first.
 *
 * - Adds `cron_last_fired.schedule_key` (= `${cronExpression}\n${timezone}`).
 * - Backfills existing rows from each registration's FIRST schedule trigger
 *   (exactly the schedule the old scheduler fired), so existing last_fired_at
 *   is preserved and NO currently-scheduled workflow re-fires on deploy.
 * - Drops the single-column PK and installs the composite PK.
 *
 * Idempotent: re-running on an already-migrated DB skips each step.
 */
async function columnExists(db: Kysely<unknown>, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cron_last_fired'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists ?? false;
}

async function primaryKeyColumns(db: Kysely<unknown>): Promise<string[]> {
  const r = await sql<{ attname: string }>`
    SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'public.cron_last_fired'::regclass
       AND i.indisprimary
     ORDER BY a.attnum
  `.execute(db);
  return r.rows.map((row) => row.attname);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'schedule_key'))) {
    await sql`ALTER TABLE public.cron_last_fired ADD COLUMN schedule_key text`.execute(db);
  }

  // Backfill from the FIRST schedule trigger of each registration's lock_entry.
  // Matches scheduleTriggerKey(): cronExpression || E'\n' || timezone.
  await sql`
    UPDATE public.cron_last_fired clf
       SET schedule_key = k.key
      FROM (
        SELECT DISTINCT ON (wr.id) wr.id AS reg_id,
               (e->>'cronExpression') || E'\n' || COALESCE(e->>'timezone', '') AS key
          FROM public.workflow_registrations wr,
               jsonb_array_elements(wr.lock_entry->'triggers') WITH ORDINALITY t(e, ord)
         WHERE e->>'_type' = 'schedule'
         ORDER BY wr.id, ord
      ) k
     WHERE clf.registration_id = k.reg_id
       AND clf.schedule_key IS NULL
  `.execute(db);

  // Orphan rows: a cron_last_fired row whose registration has no schedule
  // trigger (unreachable state) can never be re-fired — drop it.
  await sql`DELETE FROM public.cron_last_fired WHERE schedule_key IS NULL`.execute(db);

  await sql`ALTER TABLE public.cron_last_fired ALTER COLUMN schedule_key SET NOT NULL`.execute(db);

  const pk = await primaryKeyColumns(db);
  const isComposite =
    pk.length === 2 && pk.includes('registration_id') && pk.includes('schedule_key');
  if (!isComposite) {
    await sql`ALTER TABLE public.cron_last_fired DROP CONSTRAINT IF EXISTS cron_last_fired_pkey`.execute(
      db,
    );
    await sql`
      ALTER TABLE public.cron_last_fired
        ADD CONSTRAINT cron_last_fired_pkey PRIMARY KEY (registration_id, schedule_key)
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Collapse back to one row per registration (keep the most recent fire).
  // Break ties on last_fired_at with ctid so tied timestamps across two
  // schedules of the same registration still resolve to exactly one survivor —
  // a plain `last_fired_at <` leaves both tied rows and the single-column PK
  // recreation below then fails with a duplicate-key error.
  await sql`
    DELETE FROM public.cron_last_fired a
      USING public.cron_last_fired b
     WHERE a.registration_id = b.registration_id
       AND (a.last_fired_at, a.ctid) < (b.last_fired_at, b.ctid)
  `.execute(db);
  await sql`ALTER TABLE public.cron_last_fired DROP CONSTRAINT IF EXISTS cron_last_fired_pkey`.execute(
    db,
  );
  await sql`
    ALTER TABLE public.cron_last_fired
      ADD CONSTRAINT cron_last_fired_pkey PRIMARY KEY (registration_id)
  `.execute(db);
  if (await columnExists(db, 'schedule_key')) {
    await sql`ALTER TABLE public.cron_last_fired DROP COLUMN schedule_key`.execute(db);
  }
}
