import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Single row, id='default'. The orchestrator serves exactly one org, so the
  // ceiling is cluster-global — the same shape as cluster_settings.
  await db.schema
    .createTable('org_plan_headroom')
    .ifNotExists()
    .addColumn('id', 'varchar(16)', (col) => col.primaryKey())
    .addColumn('max_worker_peers', 'integer', (col) => col.notNull())
    .addColumn('org_limit', 'integer', (col) => col.notNull())
    .addColumn('org_total', 'integer', (col) => col.notNull())
    .addColumn('evict_excess', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('updated_at', sql`timestamptz`, (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('org_plan_headroom').ifExists().execute();
}
