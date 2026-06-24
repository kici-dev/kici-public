import { type Kysely, sql } from 'kysely';

/**
 * Add `host_roster.reboot_pending_until timestamptz NULL` — the persisted
 * reboot-pending flag for workflow-level host restart.
 *
 * Set when an agent's `restartHost()` step calls `host.requestReboot` (so it
 * survives an orchestrator restart during the host's reboot window). While the
 * value is in the future it (1) makes the agent's imminent disconnect an
 * expected reboot rather than a recovery-fail, (2) gates the pinned-drain off
 * so the post-restart job is not dispatched into the about-to-reboot box, and
 * (3) clears on the next reconnect (down-then-up), releasing the held job. NULL
 * = no reboot pending.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster
    ADD COLUMN IF NOT EXISTS reboot_pending_until timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster DROP COLUMN IF EXISTS reboot_pending_until`.execute(db);
}
