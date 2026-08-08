import { type Kysely, sql } from 'kysely';

/**
 * Add the `backup_runs` table: one row per successful `kici-admin db backup`,
 * recording when the orchestrator DB was last dumped plus the metadata needed
 * to reason about a restore (dump path, size, secret-key generation, server
 * version, migrations hash, host). The `checkBackupFreshness` diagnostic reads
 * `MAX(created_at)` here to answer "when did we last back up?" on a live box.
 *
 * Idempotent: guarded on table existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (await tableExists(db, 'backup_runs')) return;
  await db.schema
    .createTable('backup_runs')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('dump_path', 'text', (c) => c.notNull())
    .addColumn('byte_size', 'bigint', (c) => c.notNull())
    .addColumn('secret_key_version', 'integer')
    .addColumn('pg_server_version', 'text', (c) => c.notNull())
    .addColumn('migrations_hash', 'text', (c) => c.notNull())
    .addColumn('hostname', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('idx_backup_runs_created_at')
    .on('backup_runs')
    .column('created_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('backup_runs').ifExists().execute();
}

async function tableExists(db: Kysely<unknown>, table: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ${table}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}
