import { type Kysely, sql } from 'kysely';

/**
 * `host_roster.reboot_pending_until`: the persisted reboot-pending flag (NULL = none), set when
 * a `restartHost()` step calls `host.requestReboot`, so it survives an orchestrator restart.
 *
 * While in the future it (1) makes the agent's disconnect an expected reboot, not a
 * recovery-fail, (2) gates the pinned-drain off so the post-restart job does not dispatch to the
 * rebooting box, and (3) clears on the next reconnect, releasing the held job.
 * Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster
    ADD COLUMN IF NOT EXISTS reboot_pending_until timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster DROP COLUMN IF EXISTS reboot_pending_until`.execute(db);
}
