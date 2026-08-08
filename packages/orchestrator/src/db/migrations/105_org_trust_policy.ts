import { type Kysely, sql } from 'kysely';

/**
 * Create `org_trust_policy` — the orchestrator's cache of the Platform-owned org
 * trust policy pushed on `trust_policy.update`.
 *
 * A dedicated table rather than `org_settings` columns, because this is
 * Platform-owned policy the orchestrator consumes, not operator-owned config the
 * operator tunes. `source` records which of the two wrote the row so the admin
 * surface can present a Platform-managed policy as read-only.
 *
 * Persisting rather than caching in memory is deliberate: a security policy that
 * silently reverts to a default across a restart is worse than one that is never
 * applied.
 *
 * Idempotent: guarded by IF NOT EXISTS, so a re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.org_trust_policy (
      customer_id                TEXT PRIMARY KEY,
      fork_policy                TEXT        NOT NULL,
      unknown_contributor_policy TEXT        NOT NULL,
      workflow_change_policy     TEXT        NOT NULL,
      approval_expiry_hours      INTEGER     NOT NULL,
      source                     TEXT        NOT NULL,
      updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.org_trust_policy`.execute(db);
}
