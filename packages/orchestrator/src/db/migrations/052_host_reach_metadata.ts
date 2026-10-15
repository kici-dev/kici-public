import { type Kysely, sql } from 'kysely';

/**
 * Add SSH reach metadata so a declared host with no agent yet can be bootstrapped:
 *
 * - `host_roster.address` — IP / hostname.
 * - `host_roster.ssh_user` — login user (`root` at the use site when NULL).
 * - `host_roster.ssh_port` — port (22 at the use site when NULL).
 * - `host_roster.ssh_key_secret` — scoped-secret ref (`scope/key`) to the bring-up private key,
 *   resolved server-side; the key never lives in the roster.
 *
 * All nullable: a host without them cannot be bootstrapped and is otherwise unaffected.
 * Idempotent and additive.
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
