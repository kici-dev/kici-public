import { type Kysely, sql } from 'kysely';

/**
 * Add the database-side retention windows to `cluster_settings`.
 *
 * Retention was object-store-first: every aging table routed through
 * cold-store archive-then-delete, which needs `KICI_COLD_STORE_ENABLED=true`
 * and a bucket. With neither — the default, and the quickstart path — nothing
 * aged at all, so `execution_steps`, `event_log` and `access_log` grew without
 * bound on the operator's own disk.
 *
 * Four nullable windows, in days, plus the stamp that gates the first
 * deletion:
 *
 *   - `run_retention_days`        — terminal runs and their jobs and steps
 *   - `audit_retention_days`      — access_log, secret_audit_log, event_log
 *   - `provenance_retention_days` — attestations, pending_attestations
 *   - `held_run_retention_days`   — terminal held_runs
 *   - `retention_announced_at`    — when the sweep first reported a non-zero
 *     window. Deletion begins a week after this, so an upgrade never removes
 *     history on its first night.
 *
 * NULL means the orchestrator's own configured default applies; 0 disables
 * that window, mirroring `dispatch_queue_ttl_days`.
 *
 * Cluster-global rather than per-tenant: the sweep runs once per fleet on the
 * cleanup tick, with no tenant in scope at the read site.
 *
 * Idempotent: each column is guarded on existence, so a re-run is a no-op.
 */
const COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'run_retention_days', type: 'INTEGER' },
  { name: 'audit_retention_days', type: 'INTEGER' },
  { name: 'provenance_retention_days', type: 'INTEGER' },
  { name: 'held_run_retention_days', type: 'INTEGER' },
  { name: 'retention_announced_at', type: 'TIMESTAMPTZ' },
];

async function columnExists(db: Kysely<unknown>, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const { name, type } of COLUMNS) {
    if (await columnExists(db, name)) continue;
    await sql`ALTER TABLE public.cluster_settings ADD COLUMN ${sql.raw(name)} ${sql.raw(type)}`.execute(
      db,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const { name } of COLUMNS) {
    await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS ${sql.raw(name)}`.execute(
      db,
    );
  }
}
