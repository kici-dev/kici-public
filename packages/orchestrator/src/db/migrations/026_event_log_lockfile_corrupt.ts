import { type Kysely, sql } from 'kysely';

/**
 * Extend the event_log.status CHECK constraint with 'lockfile_corrupt' so the
 * orchestrator can log a delivery whose lock file was present but unparseable.
 * Orchestrator-only: the Platform event_log uses a separate, narrower status set.
 *
 * Idempotent: the DROP ... IF EXISTS / re-ADD pair re-runs cleanly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_status_check`.execute(db);
  await sql`
    ALTER TABLE event_log ADD CONSTRAINT event_log_status_check
    CHECK ((status = ANY (ARRAY[
      'received'::text, 'processed'::text, 'duplicate'::text,
      'lockfile_missing'::text, 'lockfile_corrupt'::text, 'failed'::text
    ])))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_status_check`.execute(db);
  await sql`
    ALTER TABLE event_log ADD CONSTRAINT event_log_status_check
    CHECK ((status = ANY (ARRAY[
      'received'::text, 'processed'::text, 'duplicate'::text,
      'lockfile_missing'::text, 'failed'::text
    ])))
  `.execute(db);
}
