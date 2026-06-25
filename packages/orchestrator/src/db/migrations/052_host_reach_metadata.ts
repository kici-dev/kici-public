import { type Kysely, sql } from 'kysely';

/**
 * Add pre-agent reach metadata to the host roster so a declared host (no agent
 * yet) can be reached over SSH for bootstrap bring-up:
 *
 * - `host_roster.address text NULL` — IP / hostname to SSH to.
 * - `host_roster.ssh_user text NULL` — SSH login user (defaults to `root` at use site).
 * - `host_roster.ssh_port int NULL` — SSH port (defaults to 22 at use site).
 * - `host_roster.ssh_key_secret text NULL` — scoped-secret ref (`scope/key`)
 *   holding the bring-up private key. The orchestrator resolves it server-side;
 *   the key never lives in the roster.
 *
 * All nullable: a host with no reach metadata simply cannot be bootstrapped and
 * behaves exactly as before. Idempotent (`ADD COLUMN IF NOT EXISTS`); additive,
 * so staging data is preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster
    ADD COLUMN IF NOT EXISTS address text,
    ADD COLUMN IF NOT EXISTS ssh_user text,
    ADD COLUMN IF NOT EXISTS ssh_port integer,
    ADD COLUMN IF NOT EXISTS ssh_key_secret text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster
    DROP COLUMN IF EXISTS address,
    DROP COLUMN IF EXISTS ssh_user,
    DROP COLUMN IF EXISTS ssh_port,
    DROP COLUMN IF EXISTS ssh_key_secret`.execute(db);
}
