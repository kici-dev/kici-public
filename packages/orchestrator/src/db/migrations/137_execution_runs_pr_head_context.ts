import { type Kysely, sql } from 'kysely';

/**
 * Add the pull-request head context to `execution_runs`: `head_ref TEXT`,
 * `head_repository TEXT` and `is_fork BOOLEAN`, all nullable.
 *
 * `execution_runs.ref` is the branch a run PRESENTS — for a pull request the
 * BASE branch, never the head branch — so it says nothing about where the code
 * came from. The OIDC mint reads this row: without these columns a fork pull
 * request and a trusted push to the same base branch mint an identical
 * identity, and a cloud trust policy cannot tell them apart.
 *
 * Written by the authoritative `onExecutionStarted` INSERT (and the two
 * failure-run recorders), never by the best-effort post-start update: a lost
 * write would make `is_fork` read as unresolved for an ordinary push and
 * defeat every policy written against it.
 *
 * Nullable, no default. NULL = "not resolved": the honest value for a row
 * written before these columns and for the two reroute projections that insert
 * from a `job.reroute` message with no event context. Derived claims render
 * NULL as `''` / `'unresolved'`, so a policy pinning one fails CLOSED; a
 * `false` default for `is_fork` would fail OPEN. Idempotent.
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
