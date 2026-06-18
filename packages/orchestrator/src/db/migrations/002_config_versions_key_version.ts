import { type Kysely, sql } from 'kysely';

/**
 * Add key_version column to config_versions so that sensitive-field encryption
 * can be rotated via `kici-admin rotate-key`.
 *
 * Existing rows are backfilled to 1 via the DEFAULT clause (every historical
 * row was encrypted under the first master-key generation). After rotation,
 * `SharedConfigStore` writes the next integer (MAX(key_version) + 1) and
 * stores the active generation alongside the ciphertext.
 *
 * No index is needed: rotation does a full-table scan; reads are by
 * `version` primary key and never filter on `key_version`.
 */

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE public.config_versions
      ADD COLUMN key_version integer NOT NULL DEFAULT 1
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE public.config_versions
      DROP COLUMN key_version
  `.execute(db);
}
