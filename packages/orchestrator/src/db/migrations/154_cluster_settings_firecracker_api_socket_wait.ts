import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global wait for a Firecracker VM's API socket after the jailer starts.
 *
 * NULL → the configured default (`KICI_FIRECRACKER_API_SOCKET_WAIT_MS`). Read per spawn: from
 * this table on a coordinator, from the leader's cluster-settings snapshot on a DB-less worker.
 *
 * BIGINT milliseconds, like every other millisecond knob on this table.
 * Idempotent: guarded on column existence.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

const COLUMNS = ['firecracker_api_socket_wait_ms'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    if (!(await columnExists(db, 'cluster_settings', column))) {
      await sql`ALTER TABLE public.cluster_settings ADD COLUMN ${sql.ref(column)} BIGINT`.execute(
        db,
      );
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS ${sql.ref(column)}`.execute(
      db,
    );
  }
}
