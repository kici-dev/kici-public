import { type Kysely, sql } from 'kysely';

/**
 * Add the pull-request head context to `execution_runs`: `head_ref TEXT`,
 * `head_repository TEXT` and `is_fork BOOLEAN`, all nullable.
 *
 * `execution_runs.ref` records the branch a run PRESENTS — for a pull request
 * that is the BASE branch, never the contributor's head branch. So the row has
 * always carried enough to say which branch a run targeted and nothing at all
 * to say where its code came from. The OIDC mint reads this row, which means a
 * fork pull request and a trusted push to the same base branch minted an
 * identical identity: a cloud trust policy pinning that identity could not tell
 * them apart.
 *
 * These three columns are the missing server truth. They are written by the
 * authoritative `onExecutionStarted` INSERT (and the two failure-run recorders),
 * never by the best-effort post-start update — a lost write would make `is_fork`
 * read as unresolved for an ordinary push and defeat every policy written
 * against it.
 *
 * Nullable, with no default. NULL means "not resolved", which is the honest
 * value for a row written before this column existed and for the two reroute
 * projections that insert from a `job.reroute` message carrying no event
 * context. Every claim derived from these columns renders NULL as `''` /
 * `'unresolved'`, so a policy that pins one fails CLOSED. A default of `false`
 * for `is_fork` would fail OPEN, which is the failure this column exists to
 * remove.
 *
 * Idempotent: each add is guarded on existence and each drop uses IF EXISTS, so
 * a re-run is a no-op.
 */
const COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ['head_ref', 'TEXT'],
  ['head_repository', 'TEXT'],
  ['is_fork', 'BOOLEAN'],
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [name, type] of COLUMNS) {
    const check = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'execution_runs'
           AND column_name = ${name}
      ) AS exists
    `.execute(db);
    if (check.rows[0]?.exists === true) continue;

    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN ${sql.raw(name)} ${sql.raw(type)}
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [name] of COLUMNS) {
    await sql`
      ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS ${sql.raw(name)}
    `.execute(db);
  }
}
