import { type Kysely, sql } from 'kysely';

/**
 * Extend the event_log.status CHECK constraint with 'shed' so the orchestrator
 * can record a breadcrumb for a delivery the ingest admission controller
 * refused under load. Without the row a shed delivery is indistinguishable
 * from one that never arrived, because the shed happens before the pipeline
 * that writes every other status.
 *
 * Orchestrator-only: the Platform event_log uses a separate, narrower status set.
 *
 * Idempotent: the DROP ... IF EXISTS / re-ADD pair re-runs cleanly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE event_log DROP CONSTRAINT IF EXISTS event_log_status_check`.execute(db);
  await sql`
    ALTER TABLE event_log ADD CONSTRAINT event_log_status_check
    CHECK ((status = ANY (ARRAY[
      'received'::text, 'shed'::text, 'processed'::text, 'duplicate'::text,
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
      'lockfile_missing'::text, 'lockfile_corrupt'::text, 'failed'::text
    ])))
  `.execute(db);
}
