import { type Kysely, sql } from 'kysely';

/**
 * Create `org_trust_directory`: the orchestrator's cache of the Platform-owned approval directory
 * pushed with the policy on `trust_policy.update` — identity links, per-member CI trust levels
 * and team memberships.
 *
 * A sibling of `org_trust_policy`, not more columns on it: the policy is scalar switches, while
 * these are structured documents the Platform replaces wholesale on every push (arrays, and a
 * user-id-keyed map for `member_ci_trust`), stored as JSONB.
 *
 * Persisting it lets `/kici approve` authorize a commenter after a restart; without it the
 * orchestrator cannot map a comment author to a KiCI user, and refuses every approval, until the
 * next Platform push.
 *
 * A Platform-attached orchestrator's only writer is the Platform; an independent one's is the
 * operator, via `kici-admin trust-policy directory-set`. The admin route refuses the local write
 * when a Platform is attached, so there is one writer and no counterpart to
 * `org_trust_policy.source`. Idempotent (IF NOT EXISTS).
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
