import { type Kysely, sql } from 'kysely';

/**
 * Record the dependency-cache key of the lock file that registered a workflow.
 *
 * `workflow_registrations.lockfile_hash` is the lock file's `lockfileHash` (the
 * package-manager lockfile hash) and `siblings_digest` its `siblingsDigest` (the
 * in-repo `workspace:` sibling closure). Together they key the dependency cache,
 * so an organization-wide run, which dispatches from its registration rather than
 * from a fetched lock file, restores its workflow's dependencies from the cache.
 *
 * Nullable and unbackfilled: null when the lock file records no key, and on every
 * row written before these columns existed. A null `lockfile_hash` means the run
 * installs its dependencies on the agent. Each row heals on its repository's next
 * default-branch push.
 *
 * Idempotent: guarded on each column's existence, so re-running is a no-op.
 */
async function colExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'workflow_registrations'
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'lockfile_hash'))) {
    await sql`ALTER TABLE public.workflow_registrations ADD COLUMN lockfile_hash text`.execute(db);
  }
  if (!(await colExists(db, 'siblings_digest'))) {
    await sql`ALTER TABLE public.workflow_registrations ADD COLUMN siblings_digest text`.execute(
      db,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.workflow_registrations DROP COLUMN IF EXISTS siblings_digest`.execute(
    db,
  );
  await sql`ALTER TABLE public.workflow_registrations DROP COLUMN IF EXISTS lockfile_hash`.execute(
    db,
  );
}
