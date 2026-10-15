import { type Kysely, sql } from 'kysely';

/**
 * `config_versions.key_version`, so `kici-admin rotate-key` can rotate sensitive-field encryption.
 *
 * The DEFAULT backfills existing rows to 1 (all encrypted under the first master-key
 * generation). After rotation, `SharedConfigStore` writes MAX(key_version) + 1 beside the
 * ciphertext.
 *
 * No index: rotation full-scans; reads go by the `version` primary key.
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
