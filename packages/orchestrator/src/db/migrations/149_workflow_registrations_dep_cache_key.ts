import { type Kysely, sql } from 'kysely';

/**
 * The registering lock file's dependency-cache key: `lockfile_hash` (`lockfileHash`, the
 * package-manager lockfile hash) and `siblings_digest` (`siblingsDigest`, the in-repo
 * `workspace:` sibling closure). An organization-wide run dispatches from its registration, not
 * a fetched lock file, so this is how it restores dependencies from the cache.
 *
 * Nullable and unbackfilled: null when the lock file records no key and on older rows. A null
 * `lockfile_hash` installs dependencies on the agent. A row heals on its repository's next
 * default-branch push.
 *
 * Idempotent per column.
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
