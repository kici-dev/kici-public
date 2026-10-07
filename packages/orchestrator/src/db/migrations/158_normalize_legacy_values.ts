import { type Kysely, sql } from 'kysely';

/**
 * Rewrite every stored legacy value the readers no longer accept, then drop
 * the hours spelling of the trust-policy approval window.
 *
 *   - `held_runs.hold_type`: `approval` → `reviewer`, `wait_timer` → `timer`.
 *   - `status` on `execution_runs`, `execution_jobs`, `execution_steps`:
 *     `passed`/`completed` → `success`, `in_progress` → `running`,
 *     `error` → `failed`, `canceled` → `cancelled`, `waiting` → `pending`.
 *     Batched, because these tables grow with run volume.
 *   - `org_trust_policy.approval_expiry_seconds` takes `approval_expiry_hours * 3600`
 *     where it is NULL, becomes NOT NULL, and `approval_expiry_hours` is dropped.
 *
 * `down` is a no-op: no reader accepts the rewritten spellings, and the hours
 * column is not recoverable without guessing.
 *
 * Idempotent: every UPDATE matches nothing on a second run, the hours backfill
 * runs only while the hours column exists, SET NOT NULL is a no-op on a NOT NULL
 * column, and the DROP is guarded by IF EXISTS.
 */
const BATCH_SIZE = 5000;

const STATUS_ALIASES: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ['passed', 'success'],
  ['completed', 'success'],
  ['in_progress', 'running'],
  ['error', 'failed'],
  ['canceled', 'cancelled'],
  ['waiting', 'pending'],
];

const STATUS_TABLES = ['execution_runs', 'execution_jobs', 'execution_steps'] as const;

async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const r = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return r.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE public.held_runs SET hold_type = 'reviewer' WHERE hold_type = 'approval'`.execute(
    db,
  );
  await sql`UPDATE public.held_runs SET hold_type = 'timer' WHERE hold_type = 'wait_timer'`.execute(
    db,
  );

  for (const table of STATUS_TABLES) {
    const target = sql.table(`public.${table}`);
    for (const [alias, canonical] of STATUS_ALIASES) {
      for (;;) {
        const result = await sql`
          UPDATE ${target} SET status = ${canonical}
           WHERE id IN (SELECT id FROM ${target} WHERE status = ${alias} LIMIT ${sql.lit(BATCH_SIZE)})
        `.execute(db);
        if ((result.numAffectedRows ?? 0n) === 0n) break;
      }
    }
  }

  if (await columnExists(db, 'org_trust_policy', 'approval_expiry_hours')) {
    await sql`
      UPDATE public.org_trust_policy
         SET approval_expiry_seconds = approval_expiry_hours * 3600
       WHERE approval_expiry_seconds IS NULL
    `.execute(db);
  }
  await sql`ALTER TABLE public.org_trust_policy ALTER COLUMN approval_expiry_seconds SET NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE public.org_trust_policy DROP COLUMN IF EXISTS approval_expiry_hours`.execute(
    db,
  );
}

export async function down(): Promise<void> {}
