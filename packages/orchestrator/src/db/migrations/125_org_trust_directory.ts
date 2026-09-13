import { type Kysely, sql } from 'kysely';

/**
 * Create `org_trust_directory` — the orchestrator's cache of the Platform-owned
 * approval directory pushed alongside the policy on `trust_policy.update`:
 * identity links, per-member CI trust levels, and team memberships.
 *
 * A sibling of `org_trust_policy` rather than more columns on it: the policy is
 * four scalar switches, while these three are structured documents the Platform
 * replaces wholesale on every push — `identity_links` and `team_memberships`
 * are arrays, `member_ci_trust` is a user-id-keyed map — so they are stored as
 * JSONB.
 *
 * Persisting rather than holding them only in memory is what lets
 * `/kici approve` authorize a commenter after a restart. Without a cached
 * directory the orchestrator cannot map a comment author onto a KiCI user at
 * all until the Platform's next push lands, so every approval is refused in the
 * meantime.
 *
 * Wherever a Platform is attached it is the only writer of this row. An
 * independent orchestrator has no Platform, so there the operator writes it
 * through `kici-admin trust-policy directory-set`. The two are mutually
 * exclusive — the admin route refuses the local write on any Platform-attached
 * orchestrator — so a deployment still only ever has one writer, and there is
 * no counterpart to `org_trust_policy.source` to record which it was.
 *
 * Idempotent: guarded by IF NOT EXISTS, so a re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.org_trust_directory (
      customer_id      TEXT PRIMARY KEY,
      identity_links   JSONB       NOT NULL,
      member_ci_trust  JSONB       NOT NULL,
      team_memberships JSONB       NOT NULL,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS public.org_trust_directory`.execute(db);
}
